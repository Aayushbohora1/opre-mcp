/** Knowledge-base record models (features, documents). */

export type FeatureStatus =
  'proposed' | 'specified' | 'implemented' | 'verified' | 'blocked' | 'dropped';
export type FeaturePriority = 'critical' | 'high' | 'medium' | 'low';

export interface FeatureRecord {
  id: string;
  name: string;
  summary: string;
  status: FeatureStatus;
  priority: FeaturePriority;
  /** Feature-level acceptance criteria, checked by validation runs. */
  acceptanceCriteria: string[];
  /** Finding ids from `research/findings.json` that justify this feature. */
  findingIds: string[];
  /** Evidence ids from `research/findings.json` observations. */
  evidenceIds: string[];
  /** Workflow ids stored in `knowledge/workflows/<id>.md`. */
  workflowIds: string[];
  /** Free-form tags used by knowledge search. */
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRef {
  id: string;
  /** Project-relative POSIX path. */
  path: string;
  title: string;
  kind: 'research' | 'knowledge' | 'planning' | 'validation' | 'generated';
  bytes: number;
  lines: number;
  summary: string;
  updatedAt: string;
}

export function newFeatureRecord(input: {
  id: string;
  name: string;
  summary: string;
  now: string;
}): FeatureRecord {
  return {
    id: input.id,
    name: input.name,
    summary: input.summary,
    status: 'proposed',
    priority: 'medium',
    acceptanceCriteria: [],
    findingIds: [],
    evidenceIds: [],
    workflowIds: [],
    tags: [],
    notes: '',
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Compact projection used by list endpoints so responses stay small. */
export interface FeatureSummary {
  id: string;
  name: string;
  status: FeatureStatus;
  priority: FeaturePriority;
  criteriaCount: number;
  openCriteriaCount: number;
  updatedAt: string;
}
