/**
 * Planning: turns research records into a dependency-ordered backlog.
 *
 * Two modes:
 *  - `draft`: OPRE proposes features/tasks derived from observed pages, forms and
 *    findings. The agent is expected to refine them before building;
 *  - `apply`: the agent submits the plan explicitly and OPRE validates ids and
 *    dependencies before persisting it.
 */

import { nowIso, shortId } from '../core/ids.js';
import { upsertGeneratedSection } from '../core/markdown.js';
import { InvalidInputError } from '../core/errors.js';
import { createFeature, readFeatures, writeFeatures } from '../knowledge/store.js';
import type { FeatureRecord } from '../knowledge/types.js';
import type { ProjectPaths } from '../project/paths.js';
import { readFindings, readPages } from '../research/store.js';
import { readPlan, writePlan } from './store.js';
import type { BrowserCheckSpec, PlanMetadata, TaskRecord } from './types.js';

export interface DraftPlanOptions {
  goal: string;
  maxFeatures: number;
  includeValidationTask: boolean;
}

export interface PlanOutcome {
  mode: 'draft' | 'apply';
  features: FeatureRecord[];
  tasks: TaskRecord[];
  metadata: PlanMetadata;
  planDocument: string;
  warnings: string[];
}

export async function draftPlan(
  paths: ProjectPaths,
  options: DraftPlanOptions,
): Promise<PlanOutcome> {
  const [pages, findings, existingFeatures] = await Promise.all([
    readPages(paths),
    readFindings(paths),
    readFeatures(paths),
  ]);
  const warnings: string[] = [];
  if (pages.length === 0) {
    warnings.push(
      'No researched pages are stored, so the draft is based on the target URL alone. Run opre.start_research first for a grounded plan.',
    );
  }

  const features = existingFeatures.slice(0, options.maxFeatures);
  const knownFeatureIds = new Set(features.map((feature) => feature.id));

  const tasks: TaskRecord[] = [];
  const foundation = makeTask({
    title: 'Scaffold the generated application and verify it runs',
    description:
      'Create the minimal runnable web application in generated-app/, wire the configured dev command, and confirm opre.run_validation can start it and load the root route.',
    kind: 'foundation',
    priority: 0,
    featureIds: [],
    dependsOn: [],
    acceptanceCriteria: [
      'The configured dev command starts and the root route returns HTTP 2xx',
      'The root route renders without uncaught console errors',
    ],
    checks: [
      {
        id: 'root-loads',
        description: 'The application root responds and renders',
        kind: 'navigate',
        target: '/',
        expected: null,
        screenshot: 'foundation-root',
      },
    ],
  });
  tasks.push(foundation);

  let priority = 1;
  const routeFeatures = pages
    .filter((page) => page.httpStatus !== null && page.httpStatus < 400)
    .slice(0, options.maxFeatures);

  for (const page of routeFeatures) {
    const featureId = `ftr_${slug(page.url)}_${shortId('x').slice(2, 8)}`;
    const findingIds = findings
      .filter((finding) => finding.statement.includes(page.url))
      .map((finding) => finding.id)
      .slice(0, 4);
    const feature = createFeature(featureId, {
      name: `Reconstruct route ${routeLabel(page.url)}`,
      summary: `Recreate the page at ${page.url}${page.title === '' ? '' : ` ("${page.title}")`}, including its ${page.links.length} link(s), ${page.forms.length} form(s) and ${page.interactive.length} interactive element(s).`,
      now: nowIso(),
      priority: page.depth === 0 ? 'critical' : 'high',
    });
    feature.status = 'specified';
    feature.findingIds = findingIds;
    feature.tags = [
      ...new Set(page.technologies.map((tech) => tech.replace(/^generator: /, ''))),
    ].slice(0, 5);
    feature.acceptanceCriteria = [
      `Navigating to ${page.url} renders the same primary sections and heading structure as the reference`,
      `All ${page.links.length} internal links resolve to implemented routes (or are recorded as intentional stubs)`,
      ...(page.forms.length > 0
        ? [
            `The ${page.forms.length} form(s) on this page accept input and validate as the reference does`,
          ]
        : []),
    ];
    knownFeatureIds.add(feature.id);
    features.push(feature);

    tasks.push(
      makeTask({
        title: `Implement route ${routeLabel(page.url)}`,
        description: `Build the ${page.url} experience with its navigation, sections and interactive elements. Evidence: ${page.id}.`,
        kind: 'feature',
        priority,
        featureIds: [featureId],
        dependsOn: [foundation.id],
        acceptanceCriteria: feature.acceptanceCriteria,
        checks: [
          {
            id: `route-${slug(page.url)}`,
            description: `${page.url} loads and renders`,
            kind: 'navigate',
            target: pathOf(page.url),
            expected: null,
            screenshot: `route-${slug(page.url)}`,
          },
        ],
      }),
    );
    priority += 1;
  }

  if (options.includeValidationTask) {
    tasks.push(
      makeTask({
        title: 'Validate the reconstructed flows end to end',
        description:
          'Run the configured acceptance checks against the generated app, record failures in validation/known-gaps.md, and close or explicitly accept every gap.',
        kind: 'validation',
        priority: 900,
        featureIds: features.map((feature) => feature.id),
        dependsOn: tasks.filter((task) => task.kind !== 'validation').map((task) => task.id),
        acceptanceCriteria: [
          'Every feature acceptance criterion is either verified by a passing check or recorded as an accepted gap with a reason',
        ],
        checks: [],
      }),
    );
  }

  const metadata: PlanMetadata = {
    generatedAt: nowIso(),
    goal: options.goal,
    orderedTaskIds: tasks.map((task) => task.id),
    rationale:
      'Tasks are ordered foundation → per-route features → validation so each step can be verified before the next begins.',
  };

  await writeFeatures(paths, dedupeById(features));
  await writePlan(paths, { metadata, tasks });
  const planDocument = renderPlan(metadata, features, tasks);
  await upsertGeneratedSection(paths.implementationPlan, planDocument);

  return { mode: 'draft', features: dedupeById(features), tasks, metadata, planDocument, warnings };
}

export interface ApplyPlanInput {
  goal: string;
  features: Array<Partial<FeatureRecord> & { name: string; summary: string }>;
  tasks: Array<{
    id?: string;
    title: string;
    description: string;
    kind?: TaskRecord['kind'];
    priority?: number;
    featureIds?: string[];
    dependsOn?: string[];
    acceptanceCriteria?: string[];
    validation?: {
      command?: string[] | null;
      checks?: BrowserCheckSpec[];
      startUrl?: string | null;
    };
    notes?: string;
  }>;
}

export async function applyPlan(paths: ProjectPaths, input: ApplyPlanInput): Promise<PlanOutcome> {
  const warnings: string[] = [];
  const existing = await readFeatures(paths);
  const features: FeatureRecord[] = existing.slice();

  for (const [index, draft] of input.features.entries()) {
    const id = draft.id ?? `ftr_${shortId('x').slice(2, 10)}_${index + 1}`;
    const base = createFeature(id, { name: draft.name, summary: draft.summary, now: nowIso() });
    const feature: FeatureRecord = {
      ...base,
      ...stripUndefined(draft),
      id,
      createdAt: draft.createdAt ?? base.createdAt,
      updatedAt: nowIso(),
    };
    const index2 = features.findIndex((entry) => entry.id === id);
    if (index2 >= 0) {
      features[index2] = feature;
    } else {
      features.push(feature);
    }
  }

  const tasks: TaskRecord[] = input.tasks.map((draft, index) => {
    const base = makeTask({
      title: draft.title,
      description: draft.description,
      kind: draft.kind ?? 'feature',
      priority: draft.priority ?? index + 1,
      featureIds: draft.featureIds ?? [],
      dependsOn: draft.dependsOn ?? [],
      acceptanceCriteria: draft.acceptanceCriteria ?? [],
      checks: draft.validation?.checks ?? [],
      command: draft.validation?.command ?? null,
      startUrl: draft.validation?.startUrl ?? null,
      notes: draft.notes ?? '',
    });
    return draft.id === undefined ? base : { ...base, id: draft.id };
  });

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        throw new InvalidInputError(`Task ${task.id} depends on unknown task "${dependency}".`, {
          hint: 'Include every dependency in the same plan, or reference a task that already exists.',
        });
      }
    }
    for (const featureId of task.featureIds) {
      if (!features.some((feature) => feature.id === featureId)) {
        warnings.push(`Task ${task.id} references unknown feature "${featureId}".`);
      }
    }
  }

  const metadata: PlanMetadata = {
    generatedAt: nowIso(),
    goal: input.goal,
    orderedTaskIds: tasks.map((task) => task.id),
    rationale: 'Plan supplied by the agent and validated by OPRE.',
  };

  await writeFeatures(paths, dedupeById(features));
  await writePlan(paths, { metadata, tasks });
  const planDocument = renderPlan(metadata, features, tasks);
  await upsertGeneratedSection(paths.implementationPlan, planDocument);

  return { mode: 'apply', features: dedupeById(features), tasks, metadata, planDocument, warnings };
}

export async function readPlanDocument(
  paths: ProjectPaths,
): Promise<{ metadata: PlanMetadata | null; tasks: TaskRecord[] }> {
  return readPlan(paths);
}

interface MakeTaskInput {
  title: string;
  description: string;
  kind: TaskRecord['kind'];
  priority: number;
  featureIds: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  checks: BrowserCheckSpec[];
  command?: string[] | null;
  startUrl?: string | null;
  notes?: string;
}

export function makeTask(input: MakeTaskInput): TaskRecord {
  const now = nowIso();
  return {
    id: `tsk_${shortId('x').slice(2, 10)}`,
    title: input.title,
    description: input.description,
    kind: input.kind,
    status: 'pending',
    priority: input.priority,
    featureIds: input.featureIds,
    dependsOn: input.dependsOn,
    acceptanceCriteria: input.acceptanceCriteria,
    validation: {
      command: input.command ?? null,
      checks: input.checks,
      startUrl: input.startUrl ?? null,
    },
    changedFiles: [],
    attemptCount: 0,
    lastResultId: null,
    notes: input.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

function renderPlan(
  metadata: PlanMetadata,
  features: FeatureRecord[],
  tasks: TaskRecord[],
): string {
  const lines: string[] = [];
  lines.push(`## Goal`);
  lines.push('');
  lines.push(metadata.goal);
  lines.push('');
  lines.push(`## Ordering`);
  lines.push('');
  lines.push(metadata.rationale);
  lines.push('');
  lines.push(`## Features (${features.length})`);
  lines.push('');
  for (const feature of features) {
    lines.push(
      `- **${feature.name}** (\`${feature.id}\`, ${feature.priority}) — ${feature.summary}`,
    );
    for (const criterion of feature.acceptanceCriteria) {
      lines.push(`  - acceptance: ${criterion}`);
    }
  }
  lines.push('');
  lines.push(`## Tasks (${tasks.length})`);
  lines.push('');
  for (const task of [...tasks].sort((a, b) => a.priority - b.priority)) {
    const deps =
      task.dependsOn.length === 0 ? 'no dependencies' : `after ${task.dependsOn.join(', ')}`;
    lines.push(`1. \`${task.id}\` [${task.kind}] **${task.title}** (${deps})`);
    lines.push(`   - ${task.description}`);
  }
  lines.push('');
  lines.push(
    '_Regenerate with `opre.create_implementation_plan`; edits outside the generated markers are preserved._',
  );
  return lines.join('\n');
}

function dedupeById(features: FeatureRecord[]): FeatureRecord[] {
  const seen = new Map<string, FeatureRecord>();
  for (const feature of features) {
    seen.set(feature.id, feature);
  }
  return [...seen.values()];
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result as Partial<T>;
}

function routeLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` === '/'
      ? '/'
      : `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function slug(value: string): string {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}
