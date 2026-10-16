import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createFeature,
  listDocuments,
  readDocument,
  upsertFeature,
  writeFeatures,
} from '../../src/knowledge/store.js';
import { searchKnowledge } from '../../src/knowledge/search.js';
import { addFinding, writePages } from '../../src/research/store.js';
import type { PageRecord } from '../../src/research/types.js';
import { makeTask } from '../../src/planning/planner.js';
import { selectNextTask, upsertTask } from '../../src/planning/store.js';
import { createProject } from '../../src/project/store.js';
import { upsertGeneratedSection } from '../../src/core/markdown.js';
import { appendSection, readJsonFile, writeJsonFile } from '../../src/core/json-store.js';
import { createTestEnv, type TestEnv } from '../helpers.js';
import { nowIso } from '../../src/core/ids.js';

async function seed(env: TestEnv) {
  const project = await createProject(env.config, {
    target: 'https://example.com',
    targetType: 'web',
  });
  const pages: PageRecord[] = Array.from({ length: 30 }, (_, index) => ({
    id: `pg_${index}`,
    url: `https://example.com/page-${index}`,
    finalUrl: `https://example.com/page-${index}`,
    title: `Page ${index}`,
    depth: 1,
    discoveredFrom: 'https://example.com',
    httpStatus: 200,
    contentType: 'text/html',
    headings: [`Heading ${index}`],
    meta: {},
    links: [{ href: `https://example.com/page-${index}`, text: 'self', internal: true }],
    forms: [],
    interactive: [],
    assets: [],
    technologies: ['generator: Vite'],
    screenshotPath: null,
    viewportsCaptured: [],
    consoleErrors: [],
    failedRequests: [],
    injectedInstructionSignals: 0,
    collectedAt: nowIso(),
    notes: '',
  }));
  await writePages(project.paths, pages);

  for (let index = 0; index < 40; index += 1) {
    await addFinding(project.paths, {
      statement: `Finding number ${index} about the checkout flow and the pricing page`,
      kind: index % 3 === 0 ? 'observed' : 'derived',
      confidence: 'medium',
      evidence: [{ sourceId: 'operator', observation: `observation ${index}`.repeat(10) }],
    });
  }

  const feature = createFeature('ftr_checkout', {
    name: 'Checkout',
    summary: 'The checkout flow lets a user review a cart and submit an order.',
    now: nowIso(),
  });
  feature.acceptanceCriteria = ['Cart totals are shown', 'Order submission returns a confirmation'];
  await upsertFeature(project.paths, feature);
  return { project, pages };
}

describe('knowledge search', () => {
  it('ranks matches and never returns the whole corpus', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const result = await searchKnowledge(
        project.paths,
        { query: 'checkout flow' },
        env.config.maxItems,
      );
      expect(result.total).toBeGreaterThan(5);
      expect(result.hits.returned).toBeLessThanOrEqual(env.config.maxItems);
      expect(result.hits.items.length).toBeLessThan(result.total);
      expect(result.hits.nextOffset).toBeGreaterThan(0);
      expect(result.hint).toBeTypeOf('string');
      expect(result.revision).toContain('findings');
    } finally {
      await env.cleanup();
    }
  });

  it('honours offset and limit for pagination', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const first = await searchKnowledge(
        project.paths,
        { query: 'pricing page', limit: 5, offset: 0 },
        25,
      );
      const second = await searchKnowledge(
        project.paths,
        { query: 'pricing page', limit: 5, offset: 5 },
        25,
      );
      const firstIds = first.hits.items.map((hit) => hit.id);
      const secondIds = second.hits.items.map((hit) => hit.id);
      expect(firstIds).toHaveLength(5);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it('filters by scope and status', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const features = await searchKnowledge(
        project.paths,
        { query: 'checkout', scope: 'features' },
        25,
      );
      expect(features.hits.items.every((hit) => hit.scope === 'features')).toBe(true);
      const proposed = await searchKnowledge(
        project.paths,
        { query: '', scope: 'features', status: 'proposed' },
        25,
      );
      expect(proposed.hits.total).toBe(1);
    } finally {
      await env.cleanup();
    }
  });

  it('keeps hits small even with large evidence payloads', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const result = await searchKnowledge(
        project.paths,
        { query: 'observation', scope: 'evidence', limit: 50, maxChars: 2_000 },
        25,
      );
      expect(JSON.stringify(result).length).toBeLessThan(4_000);
    } finally {
      await env.cleanup();
    }
  });
});

describe('task selection', () => {
  it('respects dependencies and priority', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });
      const foundation = makeTask({
        title: 'Scaffold',
        description: 'Create the app',
        kind: 'foundation',
        priority: 1,
        featureIds: [],
        dependsOn: [],
        acceptanceCriteria: [],
        checks: [],
      });
      const dependent = makeTask({
        title: 'Implement route',
        description: 'Build a route',
        kind: 'feature',
        priority: 0,
        featureIds: [],
        dependsOn: [foundation.id],
        acceptanceCriteria: [],
        checks: [],
      });
      const independent = makeTask({
        title: 'Docs',
        description: 'Write docs',
        kind: 'feature',
        priority: 5,
        featureIds: [],
        dependsOn: [],
        acceptanceCriteria: [],
        checks: [],
      });

      await upsertTask(project.paths, foundation);
      await upsertTask(project.paths, dependent);
      await upsertTask(project.paths, independent);

      const selection = await selectNextTask(project.paths);
      expect(selection.task?.id).toBe(foundation.id);
      expect(selection.blocked.map((task) => task.id)).toEqual([dependent.id]);

      foundation.status = 'done';
      await upsertTask(project.paths, foundation);
      const afterDone = await selectNextTask(project.paths);
      expect(afterDone.task?.id).toBe(dependent.id);
    } finally {
      await env.cleanup();
    }
  });

  it('reports an empty backlog clearly', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });
      expect((await selectNextTask(project.paths)).reason).toMatch(/backlog is empty/i);
    } finally {
      await env.cleanup();
    }
  });
});

describe('generated document sections', () => {
  it('replaces only the generated block and preserves operator text', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const path = join(project.paths.root, 'research/overview.md');
      await appendSection(path, '## Operator notes', 'I only care about the pricing page.');

      await upsertGeneratedSection(path, 'First generated body');
      await upsertGeneratedSection(path, 'Second generated body');

      const contents = await readFile(path, 'utf8');
      expect(contents).toContain('Second generated body');
      expect(contents).not.toContain('First generated body');
      expect(contents).toContain('I only care about the pricing page.');
    } finally {
      await env.cleanup();
    }
  });

  it('indexes documents with sizes instead of inlining them', async () => {
    const env = await createTestEnv();
    try {
      const { project } = await seed(env);
      const documents = await listDocuments(project.paths);
      expect(documents.map((document) => document.id)).toContain('knowledge/decisions.md');
      for (const document of documents) {
        expect(document.path.startsWith('/')).toBe(false);
        expect(document.bytes).toBeGreaterThan(0);
      }
      expect((await readDocument(project.paths, 'knowledge/decisions.md')).length).toBeGreaterThan(
        0,
      );
    } finally {
      await env.cleanup();
    }
  });
});

describe('json store', () => {
  it('round-trips values and survives a missing file', async () => {
    const env = await createTestEnv();
    try {
      const path = join(env.home, 'sample.json');
      expect(await readJsonFile(path, [])).toEqual([]);
      await writeJsonFile(path, [{ a: 1 }]);
      expect(await readJsonFile(path, [])).toEqual([{ a: 1 }]);
      const raw = JSON.parse(await readFile(path, 'utf8')) as {
        schemaVersion: number;
        updatedAt: string;
      };
      expect(raw.schemaVersion).toBe(1);
      expect(typeof raw.updatedAt).toBe('string');
    } finally {
      await env.cleanup();
    }
  });

  it('appends sections without removing earlier content', async () => {
    const env = await createTestEnv();
    try {
      const path = join(env.home, 'notes.md');
      await appendSection(path, '## Decisions', 'Use X');
      await appendSection(path, '## Decisions', 'Use Y');
      const contents = await readFile(path, 'utf8');
      expect(contents).toContain('Use X');
      expect(contents).toContain('Use Y');
    } finally {
      await env.cleanup();
    }
  });
});

describe('feature store', () => {
  it('stores and replaces a feature record', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });
      const feature = createFeature('ftr_x', { name: 'X', summary: 'summary', now: nowIso() });
      feature.acceptanceCriteria = ['first'];
      await upsertFeature(project.paths, feature);

      const updated = await upsertFeature(project.paths, {
        ...feature,
        acceptanceCriteria: ['first', 'second'],
        status: 'implemented',
      });
      expect(updated.acceptanceCriteria).toEqual(['first', 'second']);
      expect(updated.status).toBe('implemented');

      const stored = (
        await readJsonFile<Array<{ id: string; status: string }>>(project.paths.features, [])
      ).map((entry) => entry.id);
      expect(stored).toEqual(['ftr_x']);
      await writeFeatures(project.paths, []);
    } finally {
      await env.cleanup();
    }
  });
});
