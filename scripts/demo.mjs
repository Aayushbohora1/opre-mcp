/**
 * OPRE demo — runs the whole loop against a public page and prints what happened.
 *
 *   npm run demo                      # uses https://example.com
 *   npm run demo -- https://example.org/pricing
 *
 * It creates a throwaway project in a temp directory, so nothing on your machine
 * is touched. Use it to see the output shape before wiring OPRE into an agent.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const target = process.argv[2] ?? 'https://example.com';
const home = await mkdtemp(join(tmpdir(), 'opre-demo-'));
const serverPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const dim = (text) => `[2m${text}[0m`;
const bold = (text) => `[1m${text}[0m`;
const green = (text) => `[32m${text}[0m`;
const yellow = (text) => `[33m${text}[0m`;

function heading(step, total, text) {
  console.log(`\n${bold(`[${step}/${total}]`)} ${text}`);
  console.log(dim('─'.repeat(72)));
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, OPRE_HOME: home },
  stderr: 'ignore',
});
const client = new Client({ name: 'opre-demo', version: '1.0.0' });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((entry) => entry.text ?? '').join('\n');
  if (result.isError === true) {
    console.log(yellow(`  tool error: ${text.slice(0, 400)}`));
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(bold('\n  OPRE — Open Rebuild Engine'));
  console.log(dim(`  ${tools.length} MCP tools · target: ${target}\n`));

  heading(1, 6, 'opre.create_project — open a workspace');
  const created = await call('opre.create_project', {
    target,
    targetType: 'web',
    authorisation: 'public page, demo run',
  });
  const project = created.project;
  console.log(`  project   ${project}`);
  console.log(`  on disk   ${created.root}`);
  console.log(`  layout    research/ knowledge/ planning/ validation/ artifacts/ app/`);

  heading(2, 6, 'opre.get_guide — what should I do next?');
  const guide = await call('opre.get_guide', { project });
  console.log(`  stage     ${guide.stage}`);
  for (const step of guide.steps ?? []) {
    console.log(`  → ${step.tool.padEnd(34)} ${dim(step.why)}`);
  }
  console.log(dim(`  guardrail: ${(guide.guardrails ?? [])[0] ?? ''}`));

  heading(3, 6, 'opre.start_research — observe with a real browser');
  const research = await call('opre.start_research', {
    project,
    maxPages: 3,
    maxDepth: 1,
    includeScreenshots: true,
  });
  console.log(
    `  pages       ${research.pagesVisited} (screenshot: ${research.screenshots ? green('yes') : 'no'})`,
  );
  console.log(`  findings    ${research.findingsAdded}   sources ${research.sourcesAdded}`);
  for (const route of research.routes ?? []) {
    console.log(
      `    ${String(route.status ?? '').padEnd(4)} ${route.url}` +
        dim(`  ${route.forms} form(s), ${route.interactive} interactive, ${route.links} link(s)`),
    );
  }
  if ((research.errors ?? []).length > 0) {
    console.log(yellow(`  errors: ${research.errors.join(' | ')}`));
  }

  heading(4, 6, 'opre.get_research_summary — bounded overview');
  const summary = await call('opre.get_research_summary', { project });
  console.log(`  counts      ${JSON.stringify(summary.counts)}`);
  console.log(`  by kind     ${JSON.stringify(summary.findingsByKind ?? {})}`);
  console.log(`  technology  ${(summary.technologySignals ?? []).join(', ') || 'none detected'}`);
  for (const unknown of (summary.unknownBoundaries ?? []).slice(0, 2)) {
    console.log(dim(`  unknown: ${unknown}`));
  }

  heading(5, 6, 'opre.create_implementation_plan — evidence → backlog');
  const plan = await call('opre.create_implementation_plan', {
    project,
    goal: `Rebuild ${target} as a working web application.`,
    mode: 'draft',
  });
  console.log(`  features ${plan.featureCount}   tasks ${plan.taskCount}`);
  for (const task of (plan.tasks ?? []).slice(0, 5)) {
    console.log(`  ${task.id}  ${dim(`[${task.kind}]`)} ${task.title}`);
  }

  heading(6, 6, 'opre.prepare_build_context — exactly what the agent needs');
  const next = await call('opre.get_next_task', { project, markInProgress: true });
  const context = await call('opre.prepare_build_context', { project, taskId: next.task.id });
  console.log(`  task        ${context.task?.id} — ${context.task?.title}`);
  console.log(`  criteria    ${(context.task?.acceptanceCriteria ?? []).join(' | ') || '(none)'}`);
  console.log(
    `  budget      ${context.budget?.returnedChars} / ${context.budget?.maxChars} characters` +
      dim(`  dropped: ${(context.budget?.dropped ?? []).join(', ') || 'nothing'}`),
  );
  console.log(dim(`  next: ${next.nextStep ?? ''}`));

  const status = await call('opre.get_project_status', { project });
  console.log(
    `\n${green('  Done.')} project "${status.project?.name}" is at stage ${bold(status.stage)}.`,
  );
  console.log(dim(`  Inspect it here: ${created.root}`));
  console.log(dim(`  (temp project removed on exit; pass OPRE_HOME to keep it)\n`));
} finally {
  await client.close();
  await rm(home, { recursive: true, force: true });
}
