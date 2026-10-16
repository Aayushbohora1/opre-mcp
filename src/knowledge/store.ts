/**
 * Feature store and document registry.
 *
 * Documents are indexed (id, path, size, one-line summary) rather than inlined,
 * so retrieval tools can hand back a pointer instead of a whole document.
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { NotFoundError } from '../core/errors.js';
import { lineExcerpt } from '../core/limits.js';
import { appendSection, readJsonFile, writeJsonFile } from '../core/json-store.js';
import type { ProjectPaths } from '../project/paths.js';
import { redactSecrets } from '../security/untrusted.js';
import { newFeatureRecord, type DocumentRef, type FeatureRecord } from './types.js';

export async function readFeatures(paths: ProjectPaths): Promise<FeatureRecord[]> {
  return readJsonFile<FeatureRecord[]>(paths.features, []);
}

export async function writeFeatures(paths: ProjectPaths, features: FeatureRecord[]): Promise<void> {
  await writeJsonFile(paths.features, features);
}

export async function upsertFeature(
  paths: ProjectPaths,
  feature: FeatureRecord,
): Promise<FeatureRecord> {
  const features = await readFeatures(paths);
  const index = features.findIndex((entry) => entry.id === feature.id);
  if (index >= 0) {
    features[index] = feature;
  } else {
    features.push(feature);
  }
  await writeFeatures(paths, features);
  return feature;
}

export async function getFeature(paths: ProjectPaths, id: string): Promise<FeatureRecord> {
  const features = await readFeatures(paths);
  const feature = features.find(
    (entry) => entry.id === id || entry.name.toLowerCase() === id.toLowerCase(),
  );
  if (feature === undefined) {
    throw new NotFoundError(`Unknown feature "${id}"`, {
      hint: 'Use opre.search_knowledge or opre.get_project_status to list known features.',
    });
  }
  return feature;
}

export function createFeature(
  id: string,
  input: { name: string; summary: string; now: string; priority?: FeatureRecord['priority'] },
): FeatureRecord {
  const feature = newFeatureRecord({ id, ...input });
  if (input.priority !== undefined) {
    feature.priority = input.priority;
  }
  return feature;
}

export async function getWorkflowDoc(paths: ProjectPaths, workflowId: string): Promise<string> {
  const safe = workflowId.replace(/[^A-Za-z0-9._-]/g, '');
  const path = `${paths.workflows}/${safe}.md`;
  return readFile(path, 'utf8');
}

export async function appendWorkflowDoc(
  paths: ProjectPaths,
  workflowId: string,
  body: string,
): Promise<string> {
  const safe = workflowId.replace(/[^A-Za-z0-9._-]/g, '');
  const path = `${paths.workflows}/${safe}.md`;
  const { text } = redactSecrets(body);
  await appendSection(path, `## ${new Date().toISOString()}`, text);
  return path;
}

const DOCUMENT_KINDS: Array<{ kind: DocumentRef['kind']; glob: string[] }> = [
  { kind: 'research', glob: ['research/overview.md', 'research/architecture.md'] },
  {
    kind: 'knowledge',
    glob: ['knowledge/requirements.md', 'knowledge/decisions.md', 'knowledge/uncertainties.md'],
  },
  { kind: 'planning', glob: ['planning/implementation-plan.md'] },
  { kind: 'validation', glob: ['validation/known-gaps.md'] },
];

/** Indexes the human-readable documents that retrieval tools can excerpt. */
export async function listDocuments(paths: ProjectPaths): Promise<DocumentRef[]> {
  const documents: DocumentRef[] = [];
  for (const { kind, glob } of DOCUMENT_KINDS) {
    for (const relativePath of glob) {
      const absolute = `${paths.root}/${relativePath}`;
      const info = await statSafe(absolute);
      if (info === null) {
        continue;
      }
      const contents = await readFileSafe(absolute);
      documents.push({
        id: relativePath,
        path: relativePath,
        title: firstHeading(contents) ?? relativePath,
        kind,
        bytes: Number(info.size),
        lines: contents.length === 0 ? 0 : contents.split(/\r?\n/).length,
        summary: summarize(contents),
        updatedAt: info.mtime.toISOString(),
      });
    }
  }
  return documents;
}

export function documentIdForPath(relativePath: string): string {
  return relativePath;
}

export function toProjectRelative(paths: ProjectPaths, absolute: string): string {
  return relative(paths.root, absolute).replace(/\\/g, '/');
}

export async function readDocument(paths: ProjectPaths, documentId: string): Promise<string> {
  const documents = await listDocuments(paths);
  const document = documents.find(
    (entry) =>
      entry.id === documentId || entry.path === documentId || entry.id.endsWith(documentId),
  );
  if (document === undefined) {
    throw new NotFoundError(`Unknown document "${documentId}"`, {
      hint: `Known documents: ${documents.map((entry) => entry.id).join(', ') || '(none yet)'}`,
    });
  }
  const contents = await readFileSafe(`${paths.root}/${document.path}`);
  return contents;
}

export function excerptDocument(
  contents: string,
  startLine: number,
  maxLines: number,
): ReturnType<typeof lineExcerpt> {
  const { text } = redactSecrets(contents);
  return lineExcerpt(text, startLine, maxLines);
}

function firstHeading(contents: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/^#+\s*/, '').slice(0, 120);
    }
  }
  return null;
}

function summarize(contents: string): string {
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('- '));
  const summary = lines.slice(0, 2).join(' ').slice(0, 240);
  return summary.length > 0 ? summary : '(empty document)';
}

async function statSafe(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}
