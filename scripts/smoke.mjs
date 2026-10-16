/**
 * Manual smoke check: drives the built stdio server against a real public site
 * (no test assertions — it prints what happened).
 *
 * Usage: node scripts/smoke.mjs https://example.com
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = process.argv[2] ?? 'https://example.com';
const home = await mkdtemp(join(tmpdir(), 'opre-smoke-'));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, OPRE_HOME: home },
  stderr: 'inherit',
});
const client = new Client({ name: 'opre-smoke', version: '1.0.0' });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
  return {
    isError: result.isError === true,
    payload: (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })(),
  };
};

const { tools } = await client.listTools();
console.log(`tools: ${tools.length}`);

const created = await call('opre.create_project', {
  target,
  targetType: 'web',
  authorisation: 'smoke test against a public site',
});
console.log('project:', created.payload.project ?? created.payload);

const research = await call('opre.start_research', {
  project: created.payload.project,
  maxPages: 2,
  maxDepth: 1,
});
console.log('research:', {
  isError: research.isError,
  pages: research.payload.pagesVisited,
  findings: research.payload.findingsAdded,
  screenshots: research.payload.screenshots,
  routes: research.payload.routes?.map((route) => route.url),
});

const plan = await call('opre.create_implementation_plan', {
  project: created.payload.project,
  goal: `Rebuild ${target} as a working web application.`,
  mode: 'draft',
});
console.log('plan:', { tasks: plan.payload.taskCount, features: plan.payload.featureCount });

const next = await call('opre.get_next_task', { project: created.payload.project });
console.log('next task:', next.payload.task?.id, next.payload.task?.title);

const status = await call('opre.get_project_status', { project: created.payload.project });
console.log(
  'status:',
  status.payload.stage,
  status.payload.counts,
  'bytes:',
  JSON.stringify(status.payload).length,
);

await client.close();
console.log('OPRE_HOME:', home);
