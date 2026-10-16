/** Research persistence: sources, findings (with embedded evidence) and pages. */

import { readJsonFile, writeJsonFile } from '../core/json-store.js';
import { nowIso, shortId } from '../core/ids.js';
import type { ProjectPaths } from '../project/paths.js';
import { redactSecrets } from '../security/untrusted.js';
import type {
  EvidenceRecord,
  FindingKind,
  FindingRecord,
  PageRecord,
  SourceRecord,
  SourceType,
  VerificationStatus,
} from './types.js';

export async function readSources(paths: ProjectPaths): Promise<SourceRecord[]> {
  return readJsonFile<SourceRecord[]>(paths.sources, []);
}

export async function writeSources(paths: ProjectPaths, sources: SourceRecord[]): Promise<void> {
  await writeJsonFile(paths.sources, sources);
}

export async function upsertSource(
  paths: ProjectPaths,
  source: SourceRecord,
): Promise<SourceRecord> {
  const sources = await readSources(paths);
  const index = sources.findIndex((entry) => entry.id === source.id || entry.uri === source.uri);
  const safe: SourceRecord = {
    ...source,
    title: redactSecrets(source.title).text.slice(0, 200),
    notes: redactSecrets(source.notes).text.slice(0, 2_000),
  };
  if (index >= 0) {
    sources[index] = safe;
  } else {
    sources.push(safe);
  }
  await writeSources(paths, sources);
  return safe;
}

export async function readFindings(paths: ProjectPaths): Promise<FindingRecord[]> {
  return readJsonFile<FindingRecord[]>(paths.findings, []);
}

export async function writeFindings(paths: ProjectPaths, findings: FindingRecord[]): Promise<void> {
  await writeJsonFile(paths.findings, findings);
}

export interface AddFindingInput {
  statement: string;
  kind: FindingKind;
  confidence: FindingRecord['confidence'];
  verification?: VerificationStatus;
  sourceIds?: string[];
  workflow?: string | null;
  featureId?: string | null;
  limitations?: string[];
  evidence?: Array<{ sourceId: string; observation: string; data?: Record<string, unknown> }>;
}

export async function addFinding(
  paths: ProjectPaths,
  input: AddFindingInput,
): Promise<FindingRecord> {
  const findings = await readFindings(paths);
  const id = shortId('fnd');
  const stamp = nowIso();
  const evidence: EvidenceRecord[] = (input.evidence ?? []).map((entry) => ({
    id: shortId('ev'),
    sourceId: entry.sourceId,
    kind: input.kind,
    observation: redactSecrets(entry.observation).text.slice(0, 4_000),
    data: entry.data ?? {},
    collectedAt: stamp,
  }));
  const finding: FindingRecord = {
    id,
    kind: input.kind,
    statement: redactSecrets(input.statement).text.slice(0, 2_000),
    confidence: input.confidence,
    verification: input.verification ?? 'unverified',
    sourceIds: input.sourceIds ?? evidence.map((entry) => entry.sourceId),
    evidence,
    featureId: input.featureId ?? null,
    workflow: input.workflow ?? null,
    limitations: (input.limitations ?? []).map((entry) => redactSecrets(entry).text.slice(0, 500)),
    collectedAt: stamp,
    updatedAt: stamp,
  };
  findings.push(finding);
  await writeFindings(paths, findings);
  return finding;
}

export async function getFinding(paths: ProjectPaths, id: string): Promise<FindingRecord> {
  const findings = await readFindings(paths);
  const finding = findings.find((entry) => entry.id === id);
  if (finding === undefined) {
    throw new Error(`Unknown finding "${id}"`);
  }
  return finding;
}

export async function readPages(paths: ProjectPaths): Promise<PageRecord[]> {
  return readJsonFile<PageRecord[]>(paths.pages, []);
}

export async function writePages(paths: ProjectPaths, pages: PageRecord[]): Promise<void> {
  await writeJsonFile(paths.pages, pages);
}

export function newSourceRecord(input: {
  type: SourceType;
  uri: string;
  title: string;
  trust: SourceRecord['trust'];
  notes?: string;
  id?: string;
}): SourceRecord {
  return {
    id: input.id ?? shortId('src'),
    type: input.type,
    uri: input.uri,
    title: input.title,
    trust: input.trust,
    collectedAt: nowIso(),
    notes: input.notes ?? '',
  };
}

export function newPageRecord(input: Omit<PageRecord, 'id' | 'collectedAt'>): PageRecord {
  return { ...input, id: shortId('pg'), collectedAt: nowIso() };
}

export function summarizeCounts(
  values: readonly { status: VerificationStatus }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value.status] = (counts[value.status] ?? 0) + 1;
  }
  return counts;
}
