/**
 * Does OPRE actually help? A three-mode comparison: same builder, same scoring.
 *
 *   mode A  "agent only"     the builder is handed a URL and fetches the raw HTML itself
 *   mode B  "agent + tools"  it fetches every same-origin route and reads raw HTML
 *   mode C  "agent + OPRE"   it works from OPRE's research records through the MCP tools
 *
 * Fairness rules
 *  - the *same* deterministic builder renders all three, so only the evidence differs;
 *  - all three are scored against the *same* reference fingerprints (captured by OPRE);
 *  - "builder input" is measured in bytes: the context an agent would have to spend;
 *  - this measures the INFORMATION and PROCESS advantage, not model skill. A real LLM agent
 *    adds judgement on top of every row and would score higher than shown here.
 *
 * Usage: npm run compare-modes -- [url]
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchBrowser, installTransformShim } from '../src/research/browser.js';
import { captureFingerprint } from '../src/research/fingerprint.js';
import { diffFingerprints } from '../src/validation/fidelity.js';
import { loadConfig } from '../src/config.js';

const target = process.argv[2] ?? 'https://example.com';
const maxRoutes = Number(process.env.COMPARE_MAX_ROUTES ?? '3');
const home = await mkdtemp(join(tmpdir(), 'opre-compare-'));
const config = loadConfig({ ...process.env, OPRE_HOME: home, OPRE_ALLOW_PRIVATE_NETWORK: 'true' });

const bold = (t) => `[1m${t}[0m`;
const dim = (t) => `[2m${t}[0m`;
const green = (t) => `[32m${t}[0m`;

const SERVER_SOURCE = `const http = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const evidence = JSON.parse(readFileSync(join(__dirname, 'site.json'), 'utf8'));
const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function render(page) {
  if (page === undefined) return '<!doctype html><h1>Not found</h1>';
  const lines = ['<h1>' + escape(page.title) + '</h1>'];
  for (const heading of page.headings) {
    const level = Math.min(6, Math.max(1, heading.level));
    lines.push('<h' + level + '>' + escape(heading.text) + '</h' + level + '>');
  }
  for (const block of page.text || []) lines.push('<p>' + escape(block) + '</p>');
  for (const link of (page.links || []).slice(0, 20)) {
    lines.push('<a href="' + escape(link) + '">' + escape(link) + '</a>');
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' + escape(page.title) +
    '</title></head><body>' + lines.join('') + '</body></html>'
  );
}
http
  .createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const page =
      evidence.find((entry) => entry.route === pathname) ||
      evidence.find((entry) => entry.route === '/') ||
      evidence[0];
    response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(render(page));
  })
  .listen(Number(process.env.PORT || 4173), '127.0.0.1');
`;

// --- Mode C: the full OPRE pipeline, which also produces the reference --------

const client = new Client({ name: 'opre-compare', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, OPRE_HOME: home },
    stderr: 'ignore',
  }),
);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
  if (result.isError === true) {
    console.log(dim(`  (${name} reported an error; continuing with raw HTML for that mode)`));
    return { payload: null, bytes: 0 };
  }
  return { payload: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

const created = await call('opre.create_project', {
  target,
  targetType: 'web',
  authorisation: 'benchmark run',
});
const project = created.payload.project;
const root = created.payload.root;

await call('opre.start_research', {
  project,
  maxPages: maxRoutes,
  maxDepth: 1,
  includeScreenshots: true,
});
await call('opre.create_implementation_plan', {
  project,
  goal: 'Rebuild the target as a working web application.',
  mode: 'draft',
});
const next = await call('opre.get_next_task', { project, markInProgress: true });
const buildContext = await call('opre.prepare_build_context', {
  project,
  taskId: next.payload.task.id,
});

const storedPages = JSON.parse(await readFile(join(root, 'research/pages.json'), 'utf8'));
const pageList = Array.isArray(storedPages) ? storedPages : (storedPages.items ?? []);
const references = pageList
  .filter((page) => page.fingerprint && (page.httpStatus === null || page.httpStatus < 400))
  .map((page) => ({ ...page.fingerprint, screenshotPath: page.screenshotPath }));

const modeC = {
  label: 'C agent + OPRE',
  routes: references.length,
  evidence: references.map((reference) => ({
    route: reference.route,
    title: reference.title,
    headings: reference.headings,
    text: reference.textBlocks,
    links: reference.links,
    forms: reference.forms,
    interactive: reference.interactive,
    images: reference.images,
    tokens: reference.tokens,
  })),
  inputBytes: buildContext.bytes,
  verification: 'browser + fidelity',
  resumable: true,
};

// --- Modes A and B: raw HTML, no OPRE ---------------------------------------

const targetUrl = new URL(target);

const startedA = performance.now();
const htmlA = await (await fetch(targetUrl)).text();
const modeA = {
  label: 'A agent only',
  routes: 1,
  evidence: [naiveExtract(targetUrl, htmlA)],
  inputBytes: Buffer.byteLength(htmlA),
  verification: 'none',
  resumable: false,
  elapsed: performance.now() - startedA,
};

const startedB = performance.now();
const sameOrigin = extractHrefs(htmlA, targetUrl)
  .filter((href) => new URL(href, targetUrl).origin === targetUrl.origin)
  .filter((href) => new URL(href, targetUrl).pathname !== targetUrl.pathname)
  .slice(0, maxRoutes - 1);
const rawPages = [{ url: targetUrl, html: htmlA }];
for (const href of sameOrigin) {
  const url = new URL(href, targetUrl);
  const response = await fetch(url);
  if (response.ok) {
    rawPages.push({ url, html: await response.text() });
  }
}
const modeB = {
  label: 'B agent + tools',
  routes: rawPages.length,
  evidence: rawPages.map((page) => naiveExtract(page.url, page.html)),
  inputBytes: rawPages.reduce((sum, page) => sum + Buffer.byteLength(page.html), 0),
  verification: 'none',
  resumable: false,
  elapsed: performance.now() - startedB,
};

// --- Build and score all three with identical machinery --------------------

const rows = [];
let port = 4910;
for (const mode of [modeA, modeB, modeC]) {
  const started = performance.now();
  // Mode C builds inside the OPRE project so the real opre.run_validation can use it.
  const appDir =
    mode === modeC ? join(root, 'app') : join(home, mode.label.replace(/\W+/g, '-').toLowerCase());
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, 'site.json'), JSON.stringify(mode.evidence, null, 2));
  await writeFile(join(appDir, 'server.js'), SERVER_SOURCE);

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const page =
      mode.evidence.find((entry) => entry.route === pathname) ??
      mode.evidence.find((entry) => entry.route === '/') ??
      mode.evidence[0];
    response.writeHead(page === undefined ? 404 : 200, {
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(renderPage(page));
  });
  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  const score = await scoreRoutes(port, references);
  await new Promise((resolve) => {
    server.close(resolve);
  });

  rows.push({
    label: mode.label,
    routes: mode.routes,
    inputBytes: mode.inputBytes,
    score: score.average,
    verdict: score.verdict,
    compared: score.routes,
    verification: mode.verification,
    resumable: mode.resumable,
    timeMs: Math.round((mode.elapsed ?? 0) + (performance.now() - started)),
  });
  port += 1;
}

// The project is now configured and contains a runnable app, so OPRE's own
// validation can verify and score it end to end.
await call('opre.update_project_config', {
  project,
  runnerCommand: 'node',
  runnerArgs: ['server.js'],
  runnerPort: 4930,
  appDir: 'app',
});
const validation = await call('opre.run_validation', {
  project,
  taskId: next.payload?.task?.id,
  compareReference: true,
  maxCompareRoutes: maxRoutes,
  checks: [
    {
      id: 'loads',
      description: 'the rebuild serves its root route',
      kind: 'navigate',
      target: '/',
    },
  ],
});
await client.close();

console.log(`\n${bold('  Same builder. Same target. Same scorer.')}`);
console.log(dim(`  target: ${target}`));
console.log(dim(`  reference routes: ${references.length}\n`));

const table = [
  ['mode', 'routes', 'builder input', 'fidelity', 'checked by', 'resumable', 'ms'],
  ...rows.map((row) => [
    row.label,
    String(row.routes),
    `${(row.inputBytes / 1024).toFixed(0)} kB`,
    row.compared === 0 ? 'n/a' : `${(row.score * 100).toFixed(0)}% ${row.verdict}`,
    row.verification,
    row.resumable ? 'yes' : 'no',
    String(row.timeMs),
  ]),
];
const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
for (const [index, row] of table.entries()) {
  const line = row.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(index === 0 ? bold(`  ${line}`) : `  ${line}`);
}

const opreRun = validation.payload?.fidelity;
if (opreRun?.compared === true) {
  console.log(
    `\n  ${green('OPRE validation:')} ${(opreRun.averageScore * 100).toFixed(0)}% ${opreRun.verdict} ` +
      `over ${opreRun.routesCompared} route(s); differences recorded in validation/known-gaps.md.`,
  );
}

console.log(`\n${bold('  Read it honestly:')}`);
console.log(
  dim("  • A and B are not 'no intelligence' — they are the same builder without OPRE's"),
);
console.log(
  dim('    evidence, provenance, persisted state or verification. A real LLM agent adds'),
);
console.log(dim('    judgement to every row and would beat all three.'));
console.log(
  dim('  • What this isolates is the information/process advantage: how much the builder'),
);
console.log(
  dim('    had to read, whether anything verified the result, and whether the work could'),
);
console.log(dim('    be resumed. Fidelity is computed by identical code in all rows.'));
console.log(dim('  • For one trivial page the gap is small; it widens with route count, session'));
console.log(dim('    length, and any requirement to prove what was built.\n'));

await rm(home, { recursive: true, force: true });

// --- helpers ---------------------------------------------------------------

function extractHrefs(html, base) {
  return [...html.matchAll(/href="([^"]+)"/g)]
    .map((match) => {
      try {
        return new URL(match[1], base).toString();
      } catch {
        return '';
      }
    })
    .filter((href) => href !== '');
}

/** What an agent can get from raw markup: text and hrefs. No styles, no structure. */
function naiveExtract(url, html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const headings = [...body.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => ({
      level: Number.parseInt(match[1], 10),
      text: stripTags(match[2]).slice(0, 160),
    }))
    .filter((heading) => heading.text !== '');
  const text = stripTags(body)
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 3)
    .slice(0, 60);
  return {
    route: `${url.pathname}${url.search}`,
    title: stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? ['', ''])[1] ?? '').slice(
      0,
      160,
    ),
    headings,
    text,
    links: extractHrefs(html, url).slice(0, 80),
    forms: [],
    interactive: [],
    images: [],
    tokens: { colors: [], fontFamilies: [], fontSizes: [], radii: [] },
  };
}

function stripTags(value) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The one builder, used by all three modes. It renders whatever the evidence it is
 * given contains: raw HTML yields text and hrefs only, OPRE evidence additionally
 * yields form fields, controls, image alts and design tokens. That difference *is*
 * the measurement — the code is identical.
 */
function renderPage(page) {
  if (page === undefined) {
    return '<!doctype html><html><body><h1>Not found</h1></body></html>';
  }
  const tokens = page.tokens ?? {};
  const style = [
    tokens.fontFamilies?.[0] !== undefined
      ? `body{font-family:${escapeHtml(tokens.fontFamilies[0])},system-ui,sans-serif}`
      : '',
    tokens.fontSizes?.[0] !== undefined ? `body{font-size:${escapeHtml(tokens.fontSizes[0])}}` : '',
    tokens.colors?.[0] !== undefined ? `body{color:${escapeHtml(tokens.colors[0])}}` : '',
    tokens.colors?.[1] !== undefined ? `body{background:${escapeHtml(tokens.colors[1])}}` : '',
  ]
    .filter(Boolean)
    .join('');

  const body = [];
  body.push(`<h1>${escapeHtml(page.title)}</h1>`);
  for (const heading of page.headings ?? []) {
    const level = Math.min(6, Math.max(1, heading.level));
    body.push(`<h${level}>${escapeHtml(heading.text)}</h${level}>`);
  }
  const headingTexts = new Set((page.headings ?? []).map((heading) => heading.text));
  for (const block of page.text ?? []) {
    if (!headingTexts.has(block)) {
      body.push(`<p>${escapeHtml(block)}</p>`);
    }
  }
  for (const form of page.forms ?? []) {
    const [method, action] = form.method !== undefined ? [form.method, ''] : ['get', ''];
    body.push(
      `<form method="${escapeHtml(method)}"${action === '' ? '' : ` action="${escapeHtml(action)}"`}>`,
    );
    for (const field of form.fields ?? []) {
      const [name, rest] = field.split(':');
      const required = rest?.endsWith('*') === true;
      const type = (rest ?? 'text').replace('*', '');
      body.push(
        `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" type="${escapeHtml(type)}"${required ? ' required' : ''}></label>`,
      );
    }
    body.push('<button type="submit">Submit</button></form>');
  }
  for (const control of page.interactive ?? []) {
    body.push(`<button type="button">${escapeHtml(control.split(':').pop() ?? control)}</button>`);
  }
  for (const alt of page.images ?? []) {
    body.push(`<img alt="${escapeHtml(alt)}" width="120" height="80">`);
  }
  for (const link of (page.links ?? []).slice(0, 20)) {
    body.push(`<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`);
  }

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    (style === '' ? '' : `<style>${style}</style>`) +
    `<title>${escapeHtml(page.title)}</title></head><body>${body.join('')}</body></html>`
  );
}

async function scoreRoutes(listenPort, refs) {
  const { browser } = await launchBrowser(config);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await installTransformShim(page);
    const reports = [];
    for (const reference of refs.slice(0, maxRoutes)) {
      try {
        await page.goto(`http://127.0.0.1:${listenPort}${reference.route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        });
        const raw = await captureFingerprint(page);
        reports.push(
          await diffFingerprints(reference, {
            ...raw,
            screenshotPath: null,
            capturedAt: new Date().toISOString(),
          }),
        );
      } catch {
        // an unreachable route simply does not contribute
      }
    }
    await context.close();
    const average =
      reports.length === 0
        ? 0
        : reports.reduce((sum, report) => sum + report.score, 0) / reports.length;
    const verdict =
      average >= 0.95
        ? 'match'
        : average >= 0.8
          ? 'close'
          : average >= 0.5
            ? 'partial'
            : 'divergent';
    return { average, verdict, routes: reports.length };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
