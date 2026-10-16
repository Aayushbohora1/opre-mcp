/** Planning records: the ordered, dependency-aware implementation backlog. */

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'cancelled';

export type TaskKind = 'foundation' | 'feature' | 'integration' | 'validation' | 'research';

export interface TaskValidationSpec {
  /** Shell-free command list, executed with `shell: false` from the app directory. */
  command: string[] | null;
  /** Browser checks performed by `opre.run_validation`. */
  checks: BrowserCheckSpec[];
  startUrl: string | null;
}

export interface BrowserCheckSpec {
  id: string;
  description: string;
  kind: 'navigate' | 'assert_text' | 'assert_visible' | 'click' | 'fill' | 'screenshot';
  target: string | null;
  expected: string | null;
  /** Screenshot name hint; files land in `artifacts/screenshots/`. */
  screenshot: string | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: number;
  featureIds: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  validation: TaskValidationSpec;
  /** Files the agent said it created or modified (project-relative). */
  changedFiles: string[];
  attemptCount: number;
  lastResultId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanMetadata {
  generatedAt: string;
  goal: string;
  orderedTaskIds: string[];
  rationale: string;
}

export interface PlanState {
  metadata: PlanMetadata | null;
  tasks: TaskRecord[];
}

export function emptyPlan(): PlanState {
  return { metadata: null, tasks: [] };
}

export function isTaskActionable(task: TaskRecord): boolean {
  if (task.status === 'pending' || task.status === 'in_progress') {
    return true;
  }
  return false;
}

export function blockedReason(task: TaskRecord, byId: Map<string, TaskRecord>): string | null {
  const blocking = task.dependsOn
    .map((id) => byId.get(id))
    .filter((dependency): dependency is TaskRecord => dependency !== undefined)
    .filter((dependency) => dependency.status !== 'done' && dependency.status !== 'cancelled');
  if (blocking.length === 0) {
    return null;
  }
  return `Waiting on: ${blocking.map((dependency) => `${dependency.id} (${dependency.status})`).join(', ')}`;
}
