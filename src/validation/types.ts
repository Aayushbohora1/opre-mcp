/** Validation records: browser acceptance runs and their structured results. */

export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'blocked';
export type ValidationStatus = 'passed' | 'failed' | 'error';

export interface CheckResult {
  id: string;
  description: string;
  status: CheckStatus;
  expected: string | null;
  observed: string | null;
  durationMs: number;
  screenshotPath: string | null;
  error: string | null;
}

export interface ValidationRunRecord {
  id: string;
  taskId: string | null;
  featureIds: string[];
  target: string;
  status: ValidationStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  server: { started: boolean; command: string | null; port: number; error: string | null };
  checks: CheckResult[];
  screenshots: string[];
  consoleErrors: string[];
  failedRequests: string[];
  gaps: string[];
  attemptNumber: number;
  notes: string;
}
