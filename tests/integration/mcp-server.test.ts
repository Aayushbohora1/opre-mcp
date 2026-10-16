import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOpreServer } from '../../src/server.js';
import { createTestEnv, toolJson, toolText, type TestEnv } from '../helpers.js';
import { startTestSite, type TestSite } from '../helpers/site.js';

describe('MCP server (in-memory transport)', () => {
  let env: TestEnv;
  let site: TestSite;
  let client: Client;

  beforeAll(async () => {
    env = await createTestEnv({ OPRE_ALLOW_PRIVATE_NETWORK: 'true' });
    site = await startTestSite();
    const { server } = createOpreServer({ config: env.config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client?.close();
    await site?.close();
    await env?.cleanup();
  });

  it('exposes the documented tool surface with useful descriptions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      'opre.create_project',
      'opre.get_project_status',
      'opre.list_tasks',
      'opre.start_research',
      'opre.get_research_summary',
      'opre.search_research',
      'opre.search_knowledge',
      'opre.get_feature',
      'opre.get_evidence',
      'opre.get_document_excerpt',
      'opre.create_implementation_plan',
      'opre.get_next_task',
      'opre.update_task_status',
      'opre.prepare_build_context',
      'opre.record_implementation_result',
      'opre.run_validation',
      'opre.get_validation_report',
      'opre.inspect_app_package',
    ]) {
      expect(names).toContain(expected);
    }
    for (const tool of tools) {
      expect(tool.description ?? '').not.toBe('');
    }
  });

  it('runs the full workflow: research → plan → build → validate', async () => {
    const createdResult = await client.callTool({
      name: 'opre.create_project',
      arguments: { target: site.origin, targetType: 'web', authorisation: 'test fixture server' },
    });
    if (JSON.stringify(createdResult).includes('"isError":true')) {
      throw new Error(`create_project failed: ${toolText(createdResult)}`);
    }
    const created = toolJson<{ project: string; root: string }>(createdResult);
    const project = created.project;
    expect(created.root).toContain('opre-test-');

    // --- research -------------------------------------------------------
    const research = toolJson<{
      pagesVisited: number;
      findingsAdded: number;
      screenshots: number;
      routes: Array<{ url: string; forms: number }>;
    }>(
      await client.callTool({
        name: 'opre.start_research',
        arguments: { project, maxPages: 3, maxDepth: 1, includeScreenshots: true },
      }),
    );
    expect(research.pagesVisited).toBeGreaterThan(0);
    expect(research.findingsAdded).toBeGreaterThan(0);
    expect(research.screenshots).toBeGreaterThan(0);
    const home = research.routes.find((route) => route.url === `${site.origin}/`);
    expect(home?.forms).toBe(1);

    const summary = toolJson<{
      counts: { pages: number; findings: number };
      injectionWarnings: number;
      findings: Array<{ id: string; limitations: string[] }>;
    }>(await client.callTool({ name: 'opre.get_research_summary', arguments: { project } }));
    expect(summary.counts.pages).toBeGreaterThan(0);
    expect(summary.injectionWarnings).toBeGreaterThan(0);
    expect(summary.findings.every((finding) => finding.limitations !== undefined)).toBe(true);

    // The generated report exists and the operator section survives regeneration.
    const overview = await readFile(join(created.root, 'research/report.md'), 'utf8');
    expect(overview).toContain('## Route inventory');

    // --- planning -------------------------------------------------------
    const plan = toolJson<{
      taskCount: number;
      features: Array<{ id: string }>;
      orderedTaskIds: string[];
    }>(
      await client.callTool({
        name: 'opre.create_implementation_plan',
        arguments: {
          project,
          goal: 'Rebuild the marketing site and its signup form.',
          mode: 'draft',
        },
      }),
    );
    expect(plan.taskCount).toBeGreaterThan(1);
    expect(plan.features.length).toBeGreaterThan(0);
    expect(plan.orderedTaskIds.length).toBe(plan.taskCount);

    // --- build loop -----------------------------------------------------
    const next = toolJson<{ task: { id: string; acceptanceCriteria: string[] }; nextStep: string }>(
      await client.callTool({
        name: 'opre.get_next_task',
        arguments: { project, markInProgress: true },
      }),
    );
    expect(next.task.id).toBe(plan.orderedTaskIds[0]);
    expect(next.task.acceptanceCriteria.length).toBeGreaterThan(0);

    const context = toolJson<{
      task: { id: string };
      budget: { maxChars: number; returnedChars: number };
      app: { exists: boolean };
    }>(
      await client.callTool({
        name: 'opre.prepare_build_context',
        arguments: { project, taskId: next.task.id },
      }),
    );
    expect(context.task.id).toBe(next.task.id);
    expect(context.budget.returnedChars).toBeLessThanOrEqual(context.budget.maxChars);
    expect(context.app.exists).toBe(true);

    // Build a runnable app in generated-app/ and record the result.
    const appDir = join(created.root, 'app');
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'rebuild', private: true, scripts: { start: 'server.js' } }, null, 2),
      'utf8',
    );
    await writeFile(
      join(appDir, 'server.js'),
      [
        "const http = require('node:http');",
        'http.createServer((req, res) => {',
        "  res.writeHead(200, { 'content-type': 'text/html' });",
        "  res.end('<!doctype html><html><head><title>Rebuilt</title></head><body><h1>Rebuilt home</h1></body></html>');",
        '}).listen(Number(process.env.PORT || 4173), "127.0.0.1");',
        '',
      ].join('\n'),
      'utf8',
    );

    const recorded = toolJson<{ resultId: string; task: { status: string } }>(
      await client.callTool({
        name: 'opre.record_implementation_result',
        arguments: {
          project,
          taskId: next.task.id,
          outcome: 'succeeded',
          summary: 'Scaffolded a static server that serves the rebuilt home page.',
          changedFiles: ['app/server.js', 'app/package.json'],
          acceptanceResults: [{ criterion: next.task.acceptanceCriteria[0] ?? 'runs', met: true }],
        },
      }),
    );
    expect(recorded.task.status).toBe('done');

    // --- validation -----------------------------------------------------
    await client.callTool({
      name: 'opre.update_project_config',
      arguments: {
        project,
        runnerCommand: 'node',
        runnerArgs: ['server.js'],
        runnerPort: site.port + 1000,
        appDir: 'app',
      },
    });

    const validation = toolJson<{
      status: string;
      checks: Array<{ id: string; status: string; observed: string | null }>;
      reportPath: string;
      nextAction: string;
    }>(
      await client.callTool({
        name: 'opre.run_validation',
        arguments: { project, taskId: next.task.id },
      }),
    );
    expect(validation.status).toBe('passed');
    expect(validation.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(validation.checks[0]?.observed ?? JSON.stringify(validation.checks[0])).toContain(
      'Rebuilt',
    );
    expect(validation.reportPath).toBe('validation/runs.json');

    const report = toolJson<{ totalRuns: number; lastRun: { status: string } | null }>(
      await client.callTool({ name: 'opre.get_validation_report', arguments: { project } }),
    );
    expect(report.totalRuns).toBe(1);
    expect(report.lastRun?.status).toBe('passed');

    const screenshots = await readdir(join(created.root, 'artifacts/screenshots'));
    expect(screenshots.length).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the knowledge base out of default responses', async () => {
    const projects = toolJson<{ projects: Array<{ name: string }> }>(
      await client.callTool({ name: 'opre.list_projects', arguments: {} }),
    );
    const project = projects.projects[0]!.name;

    const statusText = toolText(
      await client.callTool({ name: 'opre.get_project_status', arguments: { project } }),
    );
    expect(statusText.length).toBeLessThan(4_000);
    expect(statusText).not.toContain('"evidence"');

    const search = toolJson<{
      hits: { items: unknown[]; total: number; hasMore: boolean };
      revision: string;
    }>(
      await client.callTool({
        name: 'opre.search_knowledge',
        arguments: { project, query: 'pricing page', limit: 5 },
      }),
    );
    expect(search.hits.items.length).toBeLessThanOrEqual(5);
    expect(search.revision).toContain('findings=');
  });

  it('records a failing validation run and exposes it for the next iteration', async () => {
    const projects = toolJson<{ projects: Array<{ name: string }> }>(
      await client.callTool({ name: 'opre.list_projects', arguments: {} }),
    );
    const project = projects.projects[0]!.name;

    const validation = toolJson<{
      status: string;
      gaps: string[];
      stopped: boolean;
      nextAction: string;
    }>(
      await client.callTool({
        name: 'opre.run_validation',
        arguments: {
          project,
          baseUrl: site.origin,
          checks: [
            {
              id: 'missing-text',
              description: 'page mentions Enterprise plan',
              kind: 'assert_text',
              expected: 'Enterprise plan',
            },
            {
              id: 'broken-nav',
              description: 'docs route exists',
              kind: 'navigate',
              target: '/docs',
              screenshot: 'docs',
            },
          ],
        },
      }),
    );
    expect(validation.status).toBe('failed');
    expect(validation.gaps.length).toBeGreaterThan(0);
    expect(validation.nextAction).toBeTypeOf('string');

    const report = toolJson<{ lastRun: { failures: number } | null; openGaps: number }>(
      await client.callTool({ name: 'opre.get_validation_report', arguments: { project } }),
    );
    expect(report.openGaps).toBeGreaterThan(0);
    expect(report.lastRun?.failures).toBeGreaterThan(0);
  });

  it('generates a project index that tracks progress', async () => {
    const created = toolJson<{ project: string; root: string }>(
      await client.callTool({
        name: 'opre.create_project',
        arguments: {
          target: 'https://index-check.example',
          targetType: 'web',
          name: 'index-check',
        },
      }),
    );

    const initial = await readFile(join(created.root, 'README.md'), 'utf8');
    expect(initial).toContain('stage: **research**');
    expect(initial).toContain('`app/` | the rebuilt application');

    await client.callTool({
      name: 'opre.create_implementation_plan',
      arguments: { project: created.project, goal: 'Rebuild the marketing site.', mode: 'draft' },
    });

    const updated = await readFile(join(created.root, 'README.md'), 'utf8');
    expect(updated).toContain('stage: **building**');
    expect(updated).toMatch(/Next task/);

    // Hand-written content outside the generated markers is preserved.
    await writeFile(
      join(created.root, 'README.md'),
      `${updated}\n## My notes\n\nKeep me.\n`,
      'utf8',
    );
    await client.callTool({
      name: 'opre.create_implementation_plan',
      arguments: { project: created.project, goal: 'Rebuild the marketing site.', mode: 'draft' },
    });
    const regenerated = await readFile(join(created.root, 'README.md'), 'utf8');
    expect(regenerated).toContain('Keep me.');
    expect(regenerated.match(/opre:generated:begin/g)).toHaveLength(1);
  });

  it('exposes a stage-aware guide with concrete next steps', async () => {
    const created = toolJson<{ project: string }>(
      await client.callTool({
        name: 'opre.create_project',
        arguments: {
          target: 'https://guide-check.example',
          targetType: 'web',
          name: 'guide-check',
        },
      }),
    );

    const before = toolJson<{
      stage: string;
      steps: Array<{ tool: string; example: Record<string, unknown> }>;
      guardrails: string[];
      unknownsYouMustState: string[];
      whereThingsLive: Record<string, string>;
    }>(await client.callTool({ name: 'opre.get_guide', arguments: { project: created.project } }));

    expect(before.stage).toBe('research');
    expect(before.steps.map((step) => step.tool)).toContain('opre.start_research');
    expect(before.steps[0]?.example['project']).toBe(created.project);
    expect(
      before.guardrails.some(
        (rule) => rule.includes('UNTRUSTED EVIDENCE') || rule.includes('evidence'),
      ),
    ).toBe(true);
    expect(before.unknownsYouMustState.length).toBeGreaterThan(0);
    expect(before.whereThingsLive['rebuilt app']).toBe('app/');
    // The guide must stay small: it is called at the start of every session.
    expect(JSON.stringify(before).length).toBeLessThan(3_000);

    await client.callTool({
      name: 'opre.create_implementation_plan',
      arguments: { project: created.project, goal: 'Rebuild the site.', mode: 'draft' },
    });

    const after = toolJson<{ stage: string; steps: Array<{ tool: string }> }>(
      await client.callTool({ name: 'opre.get_guide', arguments: { project: created.project } }),
    );
    expect(after.stage).toBe('building');
    expect(after.steps.map((step) => step.tool)).toEqual([
      'opre.get_next_task',
      'opre.prepare_build_context',
      'opre.record_implementation_result',
      'opre.run_validation',
    ]);
  });

  it('gives every tool a title and a description that says when to use it', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(25);
    for (const tool of tools) {
      expect(tool.title ?? '').not.toBe('');
      const description = tool.description ?? '';
      expect(description.length).toBeGreaterThan(40);
      expect(description.length).toBeLessThan(700);
    }
    const guide = tools.find((tool) => tool.name === 'opre.get_guide');
    expect(guide?.description).toContain('stage-aware playbook');
  });

  it('returns structured errors instead of crashing', async () => {
    const result = (await client.callTool({
      name: 'opre.get_feature',
      arguments: { project: 'does-not-exist', featureId: 'x' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as { error: string; hint?: string };
    expect(payload.error).toBeTruthy();
    expect(payload.hint).toBeTypeOf('string');
  });

  it('refuses to execute a dangerous dev-server command', async () => {
    const projects = toolJson<{ projects: Array<{ name: string }> }>(
      await client.callTool({ name: 'opre.list_projects', arguments: {} }),
    );
    const project = projects.projects[0]!.name;
    const result = (await client.callTool({
      name: 'opre.run_validation',
      arguments: { project, command: 'rm', args: ['-rf', 'generated-app'] },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('security_blocked');
  });

  it('records evidence and notes without overwriting operator text', async () => {
    const projects = toolJson<{ projects: Array<{ name: string }> }>(
      await client.callTool({ name: 'opre.list_projects', arguments: {} }),
    );
    const project = projects.projects[0]!.name;

    await client.callTool({
      name: 'opre.record_note',
      arguments: {
        project,
        kind: 'decision',
        text: 'Use a Node HTTP server; no framework needed for the landing page.',
      },
    });

    const finding = toolJson<{
      finding: { id: string; evidenceCount: number; limitations: string[] };
    }>(
      await client.callTool({
        name: 'opre.add_finding',
        arguments: {
          project,
          statement: 'The pricing page lists three plans.',
          kind: 'observed',
          confidence: 'medium',
          limitations: ['Plan prices were not verified against the API'],
          evidence: [{ sourceId: 'operator', observation: 'Visual check of /pricing' }],
        },
      }),
    );
    expect(finding.finding.evidenceCount).toBe(1);
    expect(finding.finding.limitations[0]).toContain('not verified');

    const evidence = toolJson<{ evidence: Array<{ observation: string; findingId: string }> }>(
      await client.callTool({
        name: 'opre.get_evidence',
        arguments: { project, findingId: finding.finding.id },
      }),
    );
    expect(evidence.evidence[0]?.observation).toBe('Visual check of /pricing');

    const excerpt = toolJson<{ excerpt: string; totalLines: number }>(
      await client.callTool({
        name: 'opre.get_document_excerpt',
        arguments: { project, documentId: 'knowledge/decisions.md', maxLines: 20 },
      }),
    );
    expect(excerpt.excerpt).toContain('no framework needed');
  });

  it('keeps projects isolated from each other', async () => {
    const a = toolJson<{ project: string }>(
      await client.callTool({
        name: 'opre.create_project',
        arguments: { target: 'https://isolated-a.example', targetType: 'web', name: 'isolated-a' },
      }),
    );
    const b = toolJson<{ project: string }>(
      await client.callTool({
        name: 'opre.create_project',
        arguments: { target: 'https://isolated-b.example', targetType: 'web', name: 'isolated-b' },
      }),
    );
    expect(a.project).not.toBe(b.project);

    await client.callTool({
      name: 'opre.upsert_feature',
      arguments: { project: a.project, name: 'Zqxmarker capability', summary: 'Only in project A' },
    });

    const searchA = toolJson<{ hits: { items: Array<{ title: string }>; total: number } }>(
      await client.callTool({
        name: 'opre.search_knowledge',
        arguments: { project: a.project, query: 'zqxmarker' },
      }),
    );
    const searchB = toolJson<{ hits: { items: Array<{ title: string }>; total: number } }>(
      await client.callTool({
        name: 'opre.search_knowledge',
        arguments: { project: b.project, query: 'zqxmarker' },
      }),
    );
    expect(searchA.hits.total).toBe(1);
    expect(searchB.hits.total).toBe(0);
  });
});

describe('MCP prompts', () => {
  it('exposes /opreweb and /opreapp equivalents', async () => {
    const env = await createTestEnv();
    try {
      const { server } = createOpreServer({ config: env.config });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name).sort()).toEqual(['opreapp', 'opreweb']);

      const prompt = await client.getPrompt({
        name: 'opreweb',
        arguments: { url: 'https://example.com' },
      });
      const text = JSON.stringify(prompt.messages);
      expect(text).toContain('https://example.com');
      expect(text).toContain('opre.start_research');
      expect(text).toContain('untrusted');

      await client.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe('generated app layout', () => {
  it('creates an empty app directory at project creation', async () => {
    const env = await createTestEnv();
    try {
      const { server } = createOpreServer({ config: env.config });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      const created = toolJson<{ root: string }>(
        await client.callTool({
          name: 'opre.create_project',
          arguments: { target: 'https://example.com', targetType: 'web' },
        }),
      );
      await client.close();

      const entries = await readdir(join(created.root, 'app'));
      expect(entries).toEqual([]);
      await mkdir(join(created.root, 'app/src'), { recursive: true });
      await expect(readdir(join(created.root, 'app'))).resolves.toContain('src');
    } finally {
      await env.cleanup();
    }
  });
});
