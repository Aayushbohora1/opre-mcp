/**
 * Runs the /opreweb workflow for real against a target, through the MCP server,
 * and prints what OPRE collected — including anything the target tried to do to
 * the agent.
 *
 *   node scripts/run-webflow.mjs https://example.com
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2] ?? 'https://example.com';
const authorisation =
  process.env.OPRE_AUTHORISATION ??
  'operator requested this target directly in an interactive OPRE session; no ownership claim is asserted';
// `--clone` copies assets and writes a scaffold, which reproduces the target's
// own HTML, CSS and media. It therefore requires a real authorisation string
// rather than the default "no ownership claim" note.
const cloneRequested = process.argv.includes('--clone');
if (cloneRequested && !process.env.OPRE_AUTHORISATION) {
  console.error(
    'Refusing to clone without OPRE_AUTHORISATION. Cloning copies the target\'s HTML, CSS and assets, so record how you are authorised (e.g. OPRE_AUTHORISATION="I own this site").',
  );
  process.exit(2);
}
const home = await mkdtemp(join(tmpdir(), 'opre-web-'));

const dim = (t) => `[2m${t}[0m`;
const bold = (t) => `[1m${t}[0m`;
const red = (t) => `[31m${t}[0m`;
const yellow = (t) => `[33m${t}[0m`;

const client = new Client({ name: 'opre-webflow', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, OPRE_HOME: home },
    stderr: 'inherit',
  }),
);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
  if (result.isError === true) {
    console.log(red(`  ${name} failed:\n${text}`));
    return null;
  }
  return JSON.parse(text);
}

try {
  console.log(bold(`\n  /opreweb ${target}`));
  console.log(dim(`  authorisation: ${authorisation}`));

  const created = await call('opre.create_project', {
    target,
    targetType: 'web',
    authorisation,
  });
  if (created === null) {
    process.exitCode = 1;
  } else {
    const project = created.project;
    console.log(`\n  project: ${project}\n  root:    ${created.root}`);

    const guide = await call('opre.get_guide', { project });
    console.log(`  stage: ${guide.stage} → next: ${guide.steps.map((s) => s.tool).join(', ')}\n`);

    const research = await call('opre.start_research', {
      project,
      maxPages: Number(process.env.OPRE_PAGES ?? '5'),
      maxDepth: 1,
      includeScreenshots: true,
    });
    console.log(
      `  pages ${research.pagesVisited}, findings ${research.findingsAdded}, screenshots ${research.screenshots}`,
    );
    for (const route of research.routes ?? []) {
      console.log(
        dim(
          `    ${String(route.status ?? '').padEnd(4)} ${route.url}  forms:${route.forms} interactive:${route.interactive} links:${route.links} screenshot:${route.screenshot ?? '—'}`,
        ),
      );
    }
    if ((research.errors ?? []).length > 0) {
      console.log(yellow(`  navigation errors: ${research.errors.join(' | ')}`));
    }
    if ((research.blockedRequests ?? []).length > 0) {
      console.log(
        yellow(`  blocked by policy: ${research.blockedRequests.slice(0, 5).join(' | ')}`),
      );
    }

    const summary = await call('opre.get_research_summary', { project });
    console.log(`\n  findings by kind: ${JSON.stringify(summary.findingsByKind ?? {})}`);
    console.log(`  injection warnings: ${summary.injectionWarnings}`);
    for (const finding of summary.findings ?? []) {
      console.log(`   [${finding.kind}/${finding.verification}] ${finding.statement}`);
      for (const limitation of finding.limitations ?? []) {
        console.log(dim(`        limitation: ${limitation}`));
      }
    }

    const pack = await call('opre.get_reference_pack', { project });
    console.log(
      `\n  reference pack: ${pack.totals.routes} route(s), ${pack.totals.stylesheets} stylesheet(s)`,
    );
    for (const route of pack.routes ?? []) {
      console.log(
        dim(`    ${route.route}  screenshot=${route.screenshot ?? '—'} css=${route.css ?? '—'}`),
      );
    }

    // Copying assets and scaffolding a rebuild is only done when the operator
    // asks for it explicitly *and* records a real authorisation.
    if (cloneRequested) {
      console.log(`\n  ${bold('capture assets')}`);
      const assets = await call('opre.capture_assets', { project, maxRoutes: 5 });
      if (assets !== null) {
        console.log(
          `  found ${assets.assetsFound}, downloaded ${assets.downloaded}, reused ${assets.reusedFromOtherRoutes}, failed ${assets.failed}, skipped ${assets.skipped}`,
        );
        console.log(
          `  ${(assets.bytes / 1024).toFixed(0)} kB across ${assets.manifests.length} manifest(s)`,
        );
        for (const blocked of assets.blocked ?? []) {
          console.log(yellow(`    blocked ${blocked.url} — ${blocked.reason}`));
        }
      }

      console.log(`\n  ${bold('scaffold')}`);
      const scaffold = await call('opre.scaffold_app', { project });
      if (scaffold !== null) {
        console.log(
          `  ${scaffold.routes.length} route(s), ${scaffold.files.length} file(s), ${scaffold.assetsLinked} asset(s), ${scaffold.stylesheets} stylesheet(s)`,
        );
        console.log(dim(`    app: ${join(created.root, scaffold.appDir)}`));
        for (const warning of scaffold.warnings ?? []) {
          console.log(yellow(`    ${warning}`));
        }
      }
    }

    console.log(`\n  ${bold('project kept at')}: ${created.root}`);
    console.log(dim('  (pass OPRE_KEEP=1 to keep it; otherwise this temp project is removed)\n'));
    if (process.env.OPRE_KEEP !== '1') {
      await rm(home, { recursive: true, force: true });
    }
  }
} finally {
  await client.close();
}
