/** Research record models. Every claim carries provenance. */

export type SourceType =
  | 'page'
  | 'screenshot'
  | 'documentation'
  | 'repository'
  | 'search'
  | 'package-metadata'
  | 'operator'
  | 'analysis';

export interface SourceRecord {
  id: string;
  type: SourceType;
  /** URL or project-relative path the evidence came from. */
  uri: string;
  title: string;
  collectedAt: string;
  /** `untrusted` for anything collected outside the operator's own input. */
  trust: 'untrusted' | 'derived' | 'operator';
  notes: string;
}

export type FindingKind = 'observed' | 'derived' | 'hypothesis';

export type VerificationStatus = 'verified' | 'unverified' | 'contradicted';

export interface EvidenceRecord {
  id: string;
  sourceId: string;
  kind: FindingKind;
  /** What was actually observed (quote, measurement, DOM fact, screenshot ref). */
  observation: string;
  /** Optional machine-readable payload (counts, selectors, headers). */
  data: Record<string, unknown>;
  collectedAt: string;
}

export interface FindingRecord {
  id: string;
  kind: FindingKind;
  statement: string;
  confidence: 'low' | 'medium' | 'high';
  verification: VerificationStatus;
  sourceIds: string[];
  /** Evidence is embedded so a finding is self-contained and auditable. */
  evidence: EvidenceRecord[];
  featureId: string | null;
  workflow: string | null;
  limitations: string[];
  collectedAt: string;
  updatedAt: string;
}

export function evidenceIds(finding: FindingRecord): string[] {
  return finding.evidence.map((entry) => entry.id);
}

export interface FormFieldRecord {
  name: string;
  type: string;
  label: string;
  required: boolean;
  options: string[];
}

export interface FormRecord {
  selector: string;
  action: string;
  method: string;
  fields: FormFieldRecord[];
}

export interface InteractiveRecord {
  selector: string;
  role: string;
  label: string;
  /** Where a click navigates, when known. */
  href: string | null;
}

export interface AssetRecord {
  url: string;
  type: string;
  bytes: number | null;
}

import type { PageFingerprint } from './fingerprint.js';

/** Everything about a page except the screenshot path and capture time. */
export type FingerprintRecord = Omit<PageFingerprint, 'screenshotPath' | 'capturedAt'>;

export interface StylePackRecord {
  cssPath: string | null;
  computedCssPath: string | null;
  variables: number;
  mediaQueries: number;
  keyframes: number;
  fontFaces: number;
  computedCount: number;
}

export interface AssetPackRecord {
  manifestPath: string;
  /** Stylesheet whose url(...) already points at the localised assets. */
  cssPath: string | null;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  bytes: number;
}

export interface PageRecord {
  id: string;
  url: string;
  finalUrl: string;
  title: string;
  depth: number;
  discoveredFrom: string | null;
  httpStatus: number | null;
  contentType: string | null;
  headings: string[];
  meta: Record<string, string>;
  links: Array<{ href: string; text: string; internal: boolean }>;
  forms: FormRecord[];
  interactive: InteractiveRecord[];
  assets: AssetRecord[];
  technologies: string[];
  screenshotPath: string | null;
  viewportsCaptured: string[];
  consoleErrors: string[];
  failedRequests: string[];
  injectedInstructionSignals: number;
  /** Structural signature used for fidelity comparison against the rebuild. */
  fingerprint: FingerprintRecord | null;
  /** Compact role/label tree: cheap, and resilient to layout reflow. */
  ariaSnapshotPath: string | null;
  /** The target's own CSS and a computed-style map, captured from the page. */
  stylePack: StylePackRecord | null;
  /** Localised images/fonts/media for this route, written by `opre.capture_assets`. */
  assetPack: AssetPackRecord | null;
  collectedAt: string;
  notes: string;
}

export interface ResearchRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  target: string;
  pagesVisited: number;
  maxDepthReached: number;
  limits: { maxPages: number; maxDepth: number; timeoutMs: number };
  sourcesAdded: number;
  findingsAdded: number;
  notes: string[];
}

export function newSource(input: Omit<SourceRecord, 'id' | 'collectedAt'>): SourceRecord {
  return {
    ...input,
    id: `src_${hash(input.uri + input.type)}`,
    collectedAt: new Date().toISOString(),
  };
}

function hash(value: string): string {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}
