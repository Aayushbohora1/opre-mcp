/**
 * Measures the things a user actually feels: cold start, project creation,
 * status/search latency, and browser research throughput.
 *
 * Usage: npm run bench  [-- url]
 * Prints a table; nothing is asserted here — tests assert behaviour, not speed.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { createProject } from '../src/project/store.js';
import { searchKnowledge } from '../src/knowledge/search.js';
import { researchWebsite } from '../src/research/inspector.js';
import { addFinding } from '../src/research/store.js';
import { createOpreServer } from '../src/server.js';

const url = process.argv.includes('--')
  ? process.argv[process.argv.indexOf('--') + 1]
  : 'https://example.com';
const pages = Number(process.env.BENCH_PAGES ?? '4');
const iterations = Number(process.env.BENCH_ITERATIONS ?? '200');

const results = [];
function record(label, ms, note) {
  results.push({ label, ms, note: note ?? '' });
}

const home = await mkdtemp(join(tmpdir(), 'opre-bench-'));
const config = loadConfig({ OPRE_HOME: home });

// --- 1. cold start: cost of importing the module graph (no browser) ---------
{
  const started = performance.now();
  await import('../src/server.js');
  record('module import (server graph)', performance.now() - started, 'no Playwright yet');
}

// --- 2. project creation + listing -----------------------------------------
{
  const started = performance.now();
  const project = await createProject(config, { target: url, targetType: 'web' });
  record('create_project', performance.now() - started, 'fs + manifest + index');

  const { resolveProject } = await import('../src/project/store.js');
  const resolveStarted = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await resolveProject(config, project.manifest.name);
  }
  record(
    'resolve_project',
    (performance.now() - resolveStarted) / iterations,
    `mean of ${iterations}`,
  );
}

// --- 3. retrieval latency over a populated knowledge base -------------------
{
  const { resolveProject } = await import('../src/project/store.js');
  const project = await resolveProject(config, undefined);
  for (let i = 0; i < 200; i += 1) {
    await addFinding(project.paths, {
      statement: `Synthetic finding ${i} about the checkout and pricing experience with a plausible amount of detail to search over.`,
      kind: 'derived',
      confidence: 'medium',
      evidence: [{ sourceId: 'operator', observation: `observation ${i}` }],
    });
  }
  const searchStarted = performance.now();
  for (let i = 0; i < 50; i += 1) {
    await searchKnowledge(project.paths, { query: 'checkout pricing', limit: 10 }, config.maxItems);
  }
  record('search_knowledge (200 findings)', (performance.now() - searchStarted) / 50, 'mean of 50');
}

// --- 4. browser research throughput ----------------------------------------
// A local multi-route site, so the number is reproducible and does not depend on
// a third-party site being slow, up, or shaped the way it was last month.
{
  const server = createHttpServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    response.writeHead(200, { 'content-type': 'text/html' });
    if (path === '/') {
      const links = Array.from(
        { length: Math.max(0, pages - 1) },
        (_, index) => `<a href="/page-${index}">Page ${index}</a>`,
      ).join(' ');
      response.end(
        `<!doctype html><title>Bench home</title><h1>Home</h1><form action="/x"><input name="q" required></form>${links}`,
      );
      return;
    }
    response.end(`<!doctype html><title>Bench ${path}</title><h1>${path}</h1><a href="/">Home</a>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const localConfig = loadConfig({
    ...process.env,
    OPRE_HOME: home,
    OPRE_ALLOW_PRIVATE_NETWORK: 'true',
  });
  const benchProject = await createProject(localConfig, {
    target: `http://127.0.0.1:${port}/`,
    targetType: 'web',
    name: 'bench-site',
  });

  const started = performance.now();
  const outcome = await researchWebsite(
    localConfig,
    benchProject.paths,
    benchProject.manifest,
    {
      maxPages: pages,
      maxDepth: 1,
      concurrency: localConfig.research.concurrency,
      timeoutMs: localConfig.research.timeoutMs,
      maxLinksPerPage: localConfig.research.maxLinksPerPage,
      includeScreenshots: true,
      recordHar: false,
      viewport: localConfig.research.viewports[0],
      extraPaths: [],
      notes: ['benchmark'],
    },
    { report: () => undefined },
  );
  const total = performance.now() - started;
  record(
    `research ${outcome.pages.length} page(s)`,
    total,
    `${(total / Math.max(outcome.pages.length, 1)).toFixed(0)} ms/page, concurrency ${localConfig.research.concurrency}`,
  );
  await new Promise((resolve) => server.close(resolve));
}

// --- 5. in-process tool call latency ---------------------------------------
{
  const { server } = createOpreServer({ config });
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bench', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    await client.callTool({ name: 'opre.list_projects', arguments: {} });
  }
  record(
    'opre.list_projects over MCP',
    (performance.now() - started) / iterations,
    `mean of ${iterations}`,
  );
  await client.close();
}

const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
try {
  const started = performance.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, OPRE_HOME: home },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'bench-stdio', version: '1.0.0' });
  await client.connect(transport);
  const listed = await client.listTools();
  record(
    'cold start -> first tool list',
    performance.now() - started,
    `${listed.tools.length} tools, stdio`,
  );
  await client.close();
} catch (error) {
  console.log('(built dist/index.js not available — run npm run build first)');
  void error;
}

const width = Math.max(...results.map((row) => row.label.length));
console.log('\n  OPRE benchmark');
console.log('  ' + '-'.repeat(width + 34));
for (const row of results) {
  console.log(`  ${row.label.padEnd(width)}  ${row.ms.toFixed(1).padStart(9)} ms  ${row.note}`);
}
console.log('');

await rm(home, { recursive: true, force: true });
