/**
 * End-to-end rebuild demo.
 *
 * Stands in for the coding agent with a *deterministic* builder: it reads the
 * research OPRE collected, writes a runnable static site into `app/`, and then
 * lets OPRE validate it and score it against the reference. No LLM is involved,
 * which is the point — every piece of information used to build the page came out
 * of OPRE's research records.
 *
 *   npm run rebuild-demo                      # https://example.com
 *   npm run rebuild-demo -- https://example.org
 *
 * Expect a high but honest score: the builder reproduces structure, text, links,
 * forms, controls, landmarks and design tokens from the evidence, not pixel-perfect CSS.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeSite } from './lib/static-builder.mjs';

const target = process.argv[2] ?? 'https://example.com';
const home = process.env.OPRE_HOME ?? (await mkdtemp(join(tmpdir(), 'opre-rebuild-')));
const keepProject = process.env.OPRE_HOME !== undefined;
const port = Number(process.env.OPRE_REBUILD_PORT ?? 4899);
const maxPages = Number(process.env.OPRE_REBUILD_PAGES ?? '3');
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const bold = (t) => `[1m${t}[0m`;
const dim = (t) => `[2m${t}[0m`;
const green = (t) => `[32m${t}[0m`;
const red = (t) => `[31m${t}[0m`;
const yellow = (t) => `[33m${t}[0m`;

function heading(step, total, text) {
  console.log(`\n${bold(`[${step}/6]`)} ${text}\n${dim('─'.repeat(72))}`);
}

const client = new Client({ name: 'opre-rebuild-demo', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, OPRE_HOME: home },
    stderr: 'ignore',
  }),
);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
  if (result.isError === true) {
    console.log(red(`  ${name} failed: ${text.slice(0, 300)}`));
    return null;
  }
  return JSON.parse(text);
}

try {
  heading(1, 6, 'research the target');
  const created = await call('opre.create_project', {
    target,
    targetType: 'web',
    authorisation: 'public page, rebuild demo',
    runnerCommand: 'node',
    runnerArgs: ['server.js'],
    runnerPort: port,
    appDir: 'app',
  });
  const project = created.project;
  const research = await call('opre.start_research', {
    project,
    maxPages,
    maxDepth: 1,
    includeScreenshots: true,
  });
  console.log(
    `  ${research.pagesVisited} page(s), ${research.findingsAdded} findings, ${research.screenshots} screenshot(s)`,
  );
  for (const route of research.routes ?? []) {
    console.log(dim(`    ${route.status} ${route.url}  ${route.forms} form(s)`));
  }

  heading(2, 6, 'plan the build');
  const plan = await call('opre.create_implementation_plan', {
    project,
    goal: `Rebuild ${target} as a working web application.`,
    mode: 'draft',
  });
  console.log(`  ${plan.featureCount} feature(s), ${plan.taskCount} task(s)`);
  const next = await call('opre.get_next_task', { project, markInProgress: true });
  console.log(`  first task: ${next.task.id} — ${next.task.title}`);

  heading(3, 6, 'build: generate a runnable app from the evidence');
  const root = created.root;
  const pages = JSON.parse(await readFile(join(root, 'research/pages.json'), 'utf8'));
  const pageList = Array.isArray(pages) ? pages : (pages.items ?? []);
  const evidence = pageList
    .filter((page) => page.fingerprint && (page.httpStatus === null || page.httpStatus < 400))
    .map((page) => ({
      route: page.fingerprint.route,
      title: page.fingerprint.title || page.title || 'Untitled',
      headings: page.fingerprint.headings,
      landmarks: page.fingerprint.landmarks,
      text: page.fingerprint.textBlocks,
      links: page.fingerprint.links,
      forms: page.fingerprint.forms,
      interactive: page.fingerprint.interactive,
      images: page.fingerprint.images,
      tokens: page.fingerprint.tokens,
    }));
  const routeMap = await writeSite(join(root, 'app'), evidence);
  console.log(`  routes written: ${Object.keys(routeMap).join(', ')}`);
  console.log(
    `  from ${evidence.length} researched page(s), evidence fields used: ${Object.keys(evidence[0] ?? {}).length}`,
  );

  heading(4, 6, 'record the implementation result');
  const result = await call('opre.record_implementation_result', {
    project,
    taskId: next.task.id,
    outcome: 'succeeded',
    summary: `Generated a static site for ${Object.keys(routeMap).length} route(s) from the researched evidence.`,
    changedFiles: ['app/server.js', 'app/routes.json', 'app/index.html'],
    acceptanceResults: (next.task.acceptanceCriteria ?? []).slice(0, 1).map((criterion) => ({
      criterion,
      met: true,
      note: 'served by the deterministic builder in this demo',
    })),
  });
  console.log(`  recorded ${result.resultId}, task status: ${result.task.status}`);

  heading(5, 6, 'validate in a browser');
  const validation = await call('opre.run_validation', {
    project,
    taskId: next.task.id,
    compareReference: true,
    maxCompareRoutes: maxPages,
  });
  for (const check of validation.checks ?? []) {
    const mark = check.status === 'passed' ? green('pass') : red('fail');
    console.log(`  ${mark}  ${check.id}: ${check.observed ?? check.error ?? ''}`);
  }

  heading(6, 6, 'fidelity against the reference');
  const fidelity = validation.fidelity;
  if (fidelity?.compared !== true) {
    console.log(yellow(`  not compared: ${fidelity?.note ?? 'no reference data'}`));
  } else {
    const colour = (verdict) => (verdict === 'divergent' ? red(verdict) : green(verdict));
    console.log(
      `  overall ${bold(`${(fidelity.averageScore * 100).toFixed(0)}%`)} ${colour(fidelity.verdict)} across ${fidelity.routesCompared} route(s)\n`,
    );
    for (const route of fidelity.routes) {
      console.log(
        `  ${String((route.score * 100).toFixed(0) + '%').padStart(4)}  ${route.route}  ${route.verdict}`,
      );
      for (const difference of route.topDifferences ?? []) {
        console.log(dim(`        - ${difference}`));
      }
    }
    if (fidelity.missingRoutes.length > 0) {
      console.log(yellow(`  missing routes: ${fidelity.missingRoutes.join(', ')}`));
    }
  }

  console.log(`\n${bold('  What just happened:')}`);
  console.log(
    dim('  Without OPRE, a builder would have had a URL and nothing else — no evidence,'),
  );
  console.log(dim('  no state that survives the session, and no way to know whether the result'));
  console.log(dim('  matches. With OPRE it got structured evidence, a persisted backlog, a'));
  console.log(dim('  started server, a real browser check, and a measured fidelity delta.\n'));

  if (keepProject) {
    console.log(`  project kept at: ${root}\n`);
  }
} finally {
  await client.close();
  if (!keepProject) {
    await rm(home, { recursive: true, force: true });
  }
}
