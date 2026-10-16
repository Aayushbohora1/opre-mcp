/**
 * Bounded retrieval across the project knowledge base.
 *
 * Design rules (context safety):
 *  - results are scored and capped; the whole corpus is never returned;
 *  - hits carry identifiers plus short snippets so the agent can pull exact
 *    excerpts on demand with `opre.get_document_excerpt` / `opre.get_evidence`;
 *  - `revision` lets the agent skip re-reading unchanged results.
 */

import { charLength, paginate, type Page } from '../core/limits.js';
import type { ProjectPaths } from '../project/paths.js';
import type { TaskRecord } from '../planning/types.js';
import { readTasks } from '../planning/store.js';
import type { EvidenceRecord, FindingRecord, PageRecord, SourceRecord } from '../research/types.js';
import { evidenceIds } from '../research/types.js';
import { readJsonFile } from '../core/json-store.js';
import { listDocuments, readFeatures } from './store.js';
import type { DocumentRef } from './types.js';
import type { FeatureRecord } from './types.js';

export type KnowledgeScope =
  'all' | 'features' | 'findings' | 'evidence' | 'pages' | 'tasks' | 'documents';

export interface SearchHit {
  scope: Exclude<KnowledgeScope, 'all'>;
  id: string;
  title: string;
  snippet: string;
  score: number;
  status?: string;
  path?: string;
  refs?: string[];
}

export interface KnowledgeSearchOptions {
  query: string;
  scope?: KnowledgeScope;
  offset?: number;
  limit?: number;
  status?: string;
  featureId?: string;
  maxChars?: number;
}

export interface KnowledgeSearchResult {
  query: string;
  scope: KnowledgeScope;
  revision: string;
  total: number;
  hits: Page<SearchHit>;
  truncated: boolean;
  hint: string;
}

export async function searchKnowledge(
  paths: ProjectPaths,
  options: KnowledgeSearchOptions,
  maxItems: number,
): Promise<KnowledgeSearchResult> {
  const scope = options.scope ?? 'all';
  const terms = tokenize(options.query);
  const corpus = await loadCorpus(paths);
  const hits: SearchHit[] = [];

  if (scope === 'all' || scope === 'features') {
    for (const feature of corpus.features) {
      if (options.status !== undefined && feature.status !== options.status) {
        continue;
      }
      if (options.featureId !== undefined && feature.id !== options.featureId) {
        continue;
      }
      const hit = scoreText({
        scope: 'features',
        id: feature.id,
        title: feature.name,
        snippet: feature.summary,
        status: feature.status,
        refs: [...feature.findingIds, ...feature.evidenceIds],
        text: [feature.name, feature.summary, feature.notes, feature.tags.join(' ')].join('\n'),
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  if (scope === 'all' || scope === 'findings') {
    for (const finding of corpus.findings) {
      const hit = scoreText({
        scope: 'findings',
        id: finding.id,
        title: finding.statement,
        snippet: finding.statement,
        status: finding.verification,
        refs: [...finding.sourceIds, ...evidenceIds(finding)],
        text: [finding.statement, finding.workflow ?? '', finding.limitations.join(' ')].join('\n'),
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  if (scope === 'all' || scope === 'evidence') {
    for (const evidence of corpus.evidence) {
      const hit = scoreText({
        scope: 'evidence',
        id: evidence.id,
        title: evidence.observation,
        snippet: evidence.observation,
        status: evidence.kind,
        refs: [evidence.sourceId],
        text: [evidence.observation, JSON.stringify(evidence.data)].join('\n'),
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  if (scope === 'all' || scope === 'pages') {
    for (const page of corpus.pages) {
      const hit = scoreText({
        scope: 'pages',
        id: page.id,
        title: page.title === '' ? page.url : page.title,
        snippet: `${page.url} [${page.forms.length} forms, ${page.interactive.length} interactive, ${page.links.length} links]`,
        status: String(page.httpStatus ?? 'n/a'),
        path: page.url,
        text: [page.url, page.title, page.headings.join(' '), page.technologies.join(' ')].join(
          '\n',
        ),
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  if (scope === 'all' || scope === 'tasks') {
    for (const task of corpus.tasks) {
      if (options.status !== undefined && task.status !== options.status) {
        continue;
      }
      const hit = scoreText({
        scope: 'tasks',
        id: task.id,
        title: task.title,
        snippet: task.description,
        status: task.status,
        refs: task.dependsOn,
        text: [task.id, task.title, task.description, task.acceptanceCriteria.join(' ')].join('\n'),
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  if (scope === 'all' || scope === 'documents') {
    for (const document of corpus.documents) {
      const hit = scoreText({
        scope: 'documents',
        id: document.id,
        title: document.title,
        snippet: document.summary,
        status: document.kind,
        path: document.path,
        text: `${document.title}\n${document.summary}\n${document.path}`,
        terms,
      });
      if (hit !== null) {
        hits.push(hit);
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const limit = Math.min(options.limit ?? maxItems, maxItems);
  const page = paginate(hits, options.offset ?? 0, limit, maxItems);
  const budget = options.maxChars ?? 12_000;
  let kept = page.items;
  while (kept.length > 1 && charLength(kept) > budget) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
  }

  return {
    query: options.query,
    scope,
    revision: `features=${corpus.features.length} findings=${corpus.findings.length} evidence=${corpus.evidence.length} pages=${corpus.pages.length} tasks=${corpus.tasks.length} documents=${corpus.documents.length}`,
    total: hits.length,
    hits: {
      ...page,
      items: kept,
      returned: kept.length,
      truncated: page.truncated || kept.length < page.items.length,
    },
    truncated: kept.length < hits.length,
    hint:
      hits.length > kept.length
        ? 'Showing the highest-scoring hits. Narrow the query, set scope, or fetch an exact record by id.'
        : 'Fetch exact content with opre.get_feature, opre.get_evidence, opre.get_task or opre.get_document_excerpt.',
  };
}

interface Corpus {
  features: FeatureRecord[];
  findings: FindingRecord[];
  evidence: EvidenceRecord[];
  sources: SourceRecord[];
  pages: PageRecord[];
  tasks: TaskRecord[];
  documents: DocumentRef[];
}

async function loadCorpus(paths: ProjectPaths): Promise<Corpus> {
  const [features, findings, pages, tasks, documents] = await Promise.all([
    readFeatures(paths),
    readJsonFile<FindingRecord[]>(paths.findings, []),
    readJsonFile<PageRecord[]>(paths.pages, []),
    readTasks(paths),
    listDocuments(paths),
  ]);
  const evidence = findings.flatMap((finding) => finding.evidence);
  const sources = await readJsonFile<SourceRecord[]>(paths.sources, []);
  return { features, findings, evidence, sources, pages, tasks, documents };
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

interface ScoreInput {
  scope: Exclude<KnowledgeScope, 'all'>;
  id: string;
  title: string;
  snippet: string;
  status?: string;
  path?: string;
  refs?: string[];
  text: string;
  terms: string[];
}

function scoreText(input: ScoreInput): SearchHit | null {
  if (input.terms.length === 0) {
    return {
      scope: input.scope,
      id: input.id,
      title: clip(input.title, 120),
      snippet: clip(input.snippet, 240),
      score: 0,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.refs === undefined ? {} : { refs: input.refs.slice(0, 8) }),
    };
  }

  const haystack = input.text.toLowerCase();
  const titleLower = input.title.toLowerCase();
  let score = 0;
  for (const term of input.terms) {
    if (titleLower.includes(term)) {
      score += 5;
    }
    const occurrences = countOccurrences(haystack, term);
    if (occurrences > 0) {
      score += Math.min(occurrences, 4);
    }
    if (input.id.toLowerCase() === term) {
      score += 10;
    }
  }
  if (score === 0) {
    return null;
  }
  return {
    scope: input.scope,
    id: input.id,
    title: clip(input.title, 120),
    snippet: clipBest(input.snippet, input.terms, 240),
    score,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.refs === undefined ? {} : { refs: input.refs.slice(0, 8) }),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 5) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function clipBest(text: string, terms: string[], maxChars: number): string {
  const lower = text.toLowerCase();
  let bestIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  if (bestIndex <= 40) {
    return clip(text, maxChars);
  }
  return clip(`…${text.slice(bestIndex - 40)}`, maxChars);
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
