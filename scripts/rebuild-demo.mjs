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
 * Expect a partial, honest fidelity score: the builder reproduces structure,
 * text, links, forms and tokens from the evidence, not pixel-perfect styling.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2] ?? 'https://example.com';
const home = process.env.OPRE_HOME ?? (await mkdtemp(join(tmpdir(), 'opre-rebuild-')));
const keepProject = process.env.OPRE_HOME !== undefined;
const port = Number(process.env.OPRE_REBUILD_PORT ?? 4899);
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const bold = (t) => `[1m${t}[0m`;
const dim = (t) => `[2m${t}[0m`;
const green = (t) => `[32m${t}[0m`;
const red = (t) => `[31m${t}[0m`;
const yellow = (t) => `[33m${t}[0m`;

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
    maxPages: Number(process.env.OPRE_REBUILD_PAGES ?? '3'),
    maxDepth: 1,
    includeScreenshots: true,
  });
  console.log(
    `  ${research.pagesVisited} page(s), ${research.findingsAdded} findings, ` +
      `${research.screenshots} screenshot(s)`,
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
  const appDir = join(root, 'app');
  const pages = await readPages(root);
  const built = await buildSite(appDir, pages);
  console.log(`  routes written: ${built.routes.join(', ')}`);
  console.log(`  html ${built.bytes} bytes, from ${built.sourcePages} researched page(s)`);

  heading(4, 6, 'record the implementation result');
  const result = await call('opre.record_implementation_result', {
    project,
    taskId: next.task.id,
    outcome: 'succeeded',
    summary: `Generated a static site for ${built.routes.length} route(s) from the researched evidence.`,
    changedFiles: ['app/server.js', 'app/site.json', 'app/index.html'],
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
    maxCompareRoutes: Number(process.env.OPRE_REBUILD_PAGES ?? '3'),
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
    const colour = (verdict) =>
      verdict === 'match' ? green(verdict) : verdict === 'close' ? green(verdict) : yellow(verdict);
    console.log(
      `  overall ${bold(`${(fidelity.averageScore * 100).toFixed(0)}%`)} ` +
        `${colour(fidelity.verdict)} across ${fidelity.routesCompared} route(s)\n`,
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

// ---------------------------------------------------------------------------

async function readPages(root) {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(join(root, 'research/pages.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.items ?? []);
}

/** Deterministic builder: renders each researched page from its fingerprint. */
async function buildSite(appDir, pages) {
  const usable = pages.filter(
    (page) => page.fingerprint && (page.httpStatus === null || page.httpStatus < 400),
  );
  const routes = usable.map((page) => page.fingerprint.route);
  const site = usable.map((page) => ({
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

  const html = renderIndex(site);
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'site.json'), JSON.stringify({ routes, pages: site }, null, 2));
  await writeFile(join(appDir, 'index.html'), html);
  await writeFile(join(appDir, 'server.js'), serverSource());
  return { routes, bytes: html.length, sourcePages: usable.length };
}

function renderIndex(site) {
  const first = site[0];
  if (first === undefined) {
    return '<!doctype html><title>Rebuild</title><h1>No reference pages were captured</h1>';
  }
  const colors = first.tokens.colors.slice(0, 3);
  const fontSize = first.tokens.fontSizes[0] ?? '16px';
  const fontFamily = first.tokens.fontFamilies[0] ?? 'system-ui, sans-serif';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${first.title}</title>`,
    '<style>',
    `:root { --bg: ${colors[1] ?? '#ffffff'}; --fg: ${colors[0] ?? '#111111'}; }`,
    `body { margin: 0; font-family: ${fontFamily}; font-size: ${fontSize}; background: var(--bg); color: var(--fg); }`,
    'header, nav, main, footer { padding: 1rem 1.5rem; }',
    'h1, h2, h3 { line-height: 1.2; }',
    '</style>',
    '</head>',
    '<body>',
    ...renderPage(first, true),
    ...site.slice(1).map((page) => renderPage(page, false)),
    '</body>',
    '</html>',
  ].join('\n');
}

function renderPage(page, isFirst) {
  const lines = [];
  lines.push(`<section data-route="${escapeHtml(page.route)}">`);
  if (isFirst || page.landmarks.includes('main')) {
    lines.push('<main>');
  }
  for (const heading of page.headings) {
    const level = Math.min(6, Math.max(1, heading.level));
    lines.push(`<h${level}>${escapeHtml(heading.text)}</h${level}>`);
  }
  const seen = new Set();
  for (const block of page.text) {
    if (seen.has(block) || /^h[1-6]:/.test(block)) {
      continue;
    }
    seen.add(block);
    lines.push(`<p>${escapeHtml(block)}</p>`);
  }
  for (const link of page.links.filter((href) => href !== page.route).slice(0, 24)) {
    lines.push(`<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`);
  }
  for (const form of page.forms) {
    lines.push(`<form method="${escapeHtml(form.method)}">`);
    for (const field of form.fields) {
      const [name, rest] = field.split(':');
      const required = rest?.endsWith('*') ? ' required' : '';
      const type = rest?.replace('*', '') ?? 'text';
      lines.push(
        `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" type="${escapeHtml(type)}"${required}></label>`,
      );
    }
    lines.push('<button type="submit">Submit</button></form>');
  }
  for (const control of page.interactive.slice(0, 12)) {
    lines.push(`<button type="button">${escapeHtml(control)}</button>`);
  }
  for (const alt of page.images.slice(0, 8)) {
    lines.push(`<img alt="${escapeHtml(alt)}" width="120" height="80">`);
  }
  if (isFirst || page.landmarks.includes('main')) {
    lines.push('</main>');
  }
  lines.push('</section>');
  return lines;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serverSource() {
  return `const http = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const site = JSON.parse(readFileSync(join(__dirname, 'site.json'), 'utf8'));
const byRoute = new Map(site.pages.map((page) => [page.route, page]));

function pageFor(pathname) {
  if (byRoute.has(pathname)) {
    return byRoute.get(pathname);
  }
  return byRoute.get('/') ?? site.pages[0];
}

function render(page) {
  if (page === undefined) {
    return '<!doctype html><h1>Not found</h1>';
  }
  const escape = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  const section = html.slice(
    html.indexOf('<section data-route="' + page.route + '"'),
    html.indexOf('</section>', html.indexOf('<section data-route="' + page.route + '"')) + '</section>'.length,
  );
  const parts = [escape(page.title)];
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + parts[0] + '</title></head><body>' + section + '</body></html>';
}

http
  .createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const page = pageFor(pathname);
    response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(render(page));
  })
  .listen(Number(process.env.PORT || 4173), '127.0.0.1');
`;
}
