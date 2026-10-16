/**
 * Build context assembly.
 *
 * The agent gets exactly what one task needs: the task, its features and
 * acceptance criteria, the findings/evidence that justify them, relevant page
 * references, prior decisions, and the validation plan. Everything is bounded
 * and every dropped section is reported.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpreConfig } from '../config.js';
import { charLength, truncateChars } from '../core/limits.js';
import { nowIso } from '../core/ids.js';
import { readFeatures } from '../knowledge/store.js';
import { searchKnowledge } from '../knowledge/search.js';
import { readPlan, getTask } from '../planning/store.js';
import type { TaskRecord } from '../planning/types.js';
import type { ProjectPaths } from '../project/paths.js';
import { readFindings, readPages } from '../research/store.js';
import type { EvidenceRecord, FindingRecord } from '../research/types.js';
import { readBuildResults, writeBuildResults } from './store.js';
import type { BuildResultRecord } from './types.js';

export interface BuildContextOptions {
  taskId: string;
  maxChars?: number;
  includeEvidence?: boolean;
  query?: string;
}

export interface BuildContext {
  project: { name: string; root: string; target: string };
  task: TaskRecord;
  features: Array<{
    id: string;
    name: string;
    status: string;
    summary: string;
    acceptanceCriteria: string[];
    openNotes: string;
  }>;
  findings: FindingRecord[];
  evidence: EvidenceRecord[];
  pages: Array<{
    id: string;
    url: string;
    title: string;
    screenshot: string | null;
    forms: number;
  }>;
  recentDecisions: string;
  previousResults: Array<{ id: string; outcome: string; summary: string; createdAt: string }>;
  generatedApp: { exists: boolean; entryFiles: string[]; packageScripts: Record<string, string> };
  validationPlan: {
    command: string[] | null;
    checks: TaskRecord['validation']['checks'];
    startUrl: string | null;
  };
  budget: { maxChars: number; returnedChars: number; dropped: string[] };
  nextAction: string;
}

export async function prepareBuildContext(
  paths: ProjectPaths,
  manifest: { name: string; target: string },
  options: BuildContextOptions,
  config: OpreConfig,
): Promise<BuildContext> {
  const maxChars = options.maxChars ?? Math.max(4_000, Math.floor(config.maxResponseChars * 0.7));
  const dropped: string[] = [];
  const task = await getTask(paths, options.taskId);

  const features = (await readFeatures(paths)).filter((feature) =>
    task.featureIds.includes(feature.id),
  );
  const findings = await readFindings(paths);
  const referenced = findings.filter(
    (finding) =>
      features.some((feature) => feature.findingIds.includes(finding.id)) ||
      task.featureIds.length === 0 ||
      matchesQuery(finding.statement, options.query),
  );
  const evidence =
    (options.includeEvidence ?? true)
      ? referenced.flatMap((finding) => finding.evidence).slice(0, 12)
      : [];

  const pages = (await readPages(paths))
    .filter((page) => referencesTask(page.url + page.title, task))
    .slice(0, 8)
    .map((page) => ({
      id: page.id,
      url: page.url,
      title: page.title,
      screenshot: page.screenshotPath,
      forms: page.forms.length,
    }));

  const recentDecisions = await tail(join(paths.root, 'knowledge/decisions.md'), 40);
  const results = await readBuildResults(paths);
  const previousResults = results
    .filter((result) => result.taskId === task.id)
    .slice(-3)
    .map((result) => ({
      id: result.id,
      outcome: result.outcome,
      summary: result.summary,
      createdAt: result.createdAt,
    }));

  const generatedApp = await describeGeneratedApp(paths);

  const context: BuildContext = {
    project: { name: manifest.name, root: paths.root, target: manifest.target },
    task,
    features: features.map((feature) => ({
      id: feature.id,
      name: feature.name,
      status: feature.status,
      summary: feature.summary,
      acceptanceCriteria: feature.acceptanceCriteria,
      openNotes: feature.notes,
    })),
    findings: referenced.slice(0, 10),
    evidence,
    pages,
    recentDecisions,
    previousResults,
    generatedApp,
    validationPlan: {
      command: task.validation.command,
      checks: task.validation.checks,
      startUrl: task.validation.startUrl,
    },
    budget: { maxChars, returnedChars: 0, dropped },
    nextAction:
      task.status === 'in_progress'
        ? 'Resume this task, then record the result with opre.record_implementation_result.'
        : 'Set the task to in_progress with opre.update_task_status, implement it, then record the result.',
  };

  enforceBudget(context, maxChars, dropped);
  return context;
}

function enforceBudget(context: BuildContext, maxChars: number, dropped: string[]): void {
  if (charLength(context) <= maxChars) {
    context.budget.returnedChars = charLength(context);
    return;
  }

  context.evidence = [];
  dropped.push('evidence (trimmed to fit the response budget; fetch with opre.get_evidence)');
  if (charLength(context) <= maxChars) {
    context.budget.returnedChars = charLength(context);
    return;
  }

  context.findings = context.findings.slice(0, 3).map((finding) => ({
    ...finding,
    statement: truncateChars(finding.statement, 300).text,
    limitations: finding.limitations.slice(0, 2),
  }));
  dropped.push('findings reduced to the 3 highest-priority records');
  if (charLength(context) <= maxChars) {
    context.budget.returnedChars = charLength(context);
    return;
  }

  context.recentDecisions = truncateChars(context.recentDecisions, 1_500).text;
  dropped.push('decisions.md tail truncated');
  context.budget.returnedChars = charLength(context);
  context.budget.dropped = [...new Set(dropped)];
  if (charLength(context) > maxChars) {
    dropped.push(
      'payload still exceeds the budget; consider a narrower query or raise OPRE_MAX_RESPONSE_CHARS',
    );
  }
}

export async function recordBuildResult(
  paths: ProjectPaths,
  record: BuildResultRecord,
): Promise<{ results: BuildResultRecord[] }> {
  const results = await readBuildResults(paths);
  results.push(record);
  await writeBuildResults(paths, results);
  return { results };
}

export function newBuildResult(
  input: Omit<BuildResultRecord, 'id' | 'createdAt'>,
): BuildResultRecord {
  return {
    ...input,
    id: `res_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: nowIso(),
  };
}

async function tail(path: string, lines: number): Promise<string> {
  try {
    const contents = await readFile(path, 'utf8');
    const all = contents.split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch {
    return '';
  }
}

async function describeGeneratedApp(paths: ProjectPaths): Promise<BuildContext['generatedApp']> {
  const appDir = join(paths.root, 'generated-app');
  const exists = await stat(appDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!exists) {
    return { exists: false, entryFiles: [], packageScripts: {} };
  }
  const entries = await readdir(appDir, { withFileTypes: true }).catch(() => []);
  const entryFiles = entries.slice(0, 40).map((entry) => entry.name);
  let packageScripts: Record<string, string> = {};
  try {
    const manifest = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    packageScripts = manifest.scripts ?? {};
  } catch {
    packageScripts = {};
  }
  return { exists: true, entryFiles, packageScripts };
}

function matchesQuery(text: string, query: string | undefined): boolean {
  if (query === undefined || query.trim() === '') {
    return false;
  }
  const needle = query.toLowerCase();
  return text.toLowerCase().includes(needle);
}

function referencesTask(haystack: string, task: TaskRecord): boolean {
  const terms = [...task.acceptanceCriteria, task.title]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= 4);
  return terms.some((term) => haystack.toLowerCase().includes(term));
}

export { readPlan, searchKnowledge };
