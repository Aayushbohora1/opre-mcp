/** Build-loop records: one entry per implementation attempt. */

export type BuildOutcome = 'succeeded' | 'partial' | 'failed';

export interface BuildResultRecord {
  id: string;
  taskId: string;
  featureIds: string[];
  outcome: BuildOutcome;
  summary: string;
  changedFiles: string[];
  commandsRun: Array<{ command: string; exitCode: number | null; note: string }>;
  acceptanceResults: Array<{ criterion: string; met: boolean; note: string }>;
  /** Gaps discovered while implementing; fed back into the knowledge base. */
  gaps: Array<{ summary: string; severity: 'low' | 'medium' | 'high' }>;
  nextSteps: string[];
  createdAt: string;
}

export interface BuildState {
  results: BuildResultRecord[];
}
