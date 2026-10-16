/** Task persistence and dependency-aware selection of the next task. */

import { readJsonFile, writeJsonFile } from '../core/json-store.js';
import { NotFoundError } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { ProjectPaths } from '../project/paths.js';
import { assertSafeSegment } from '../security/paths.js';
import { blockedReason, type PlanState, type TaskRecord, type TaskStatus } from './types.js';

const PLAN_KEY = 'plan';

export async function readPlan(paths: ProjectPaths): Promise<PlanState> {
  const raw = await readJsonFile<{ plan: PlanState | null; tasks: TaskRecord[] }>(paths.tasks, {
    plan: null,
    tasks: [],
  });
  if (raw.plan !== null && raw.plan !== undefined) {
    return { metadata: raw.plan.metadata ?? null, tasks: raw.tasks ?? [] };
  }
  return { metadata: null, tasks: raw.tasks ?? [] };
}

export async function writePlan(paths: ProjectPaths, state: PlanState): Promise<void> {
  await writeJsonFile(paths.tasks, { [PLAN_KEY]: state.metadata, tasks: state.tasks });
}

export async function readTasks(paths: ProjectPaths): Promise<TaskRecord[]> {
  return (await readPlan(paths)).tasks;
}

export async function writeTasks(paths: ProjectPaths, tasks: TaskRecord[]): Promise<void> {
  const current = await readPlan(paths);
  await writePlan(paths, { metadata: current.metadata, tasks });
}

export async function getTask(paths: ProjectPaths, id: string): Promise<TaskRecord> {
  assertSafeSegment(id, 'task id');
  const tasks = await readTasks(paths);
  const task = tasks.find((entry) => entry.id === id);
  if (task === undefined) {
    throw new NotFoundError(`Unknown task "${id}"`, {
      hint: 'Use opre.list_tasks or opre.get_next_task to see the backlog.',
    });
  }
  return task;
}

export async function upsertTask(paths: ProjectPaths, task: TaskRecord): Promise<TaskRecord> {
  const state = await readPlan(paths);
  const index = state.tasks.findIndex((entry) => entry.id === task.id);
  if (index >= 0) {
    state.tasks[index] = task;
  } else {
    state.tasks.push(task);
  }
  await writePlan(paths, state);
  return task;
}

export async function saveTaskStatus(
  paths: ProjectPaths,
  id: string,
  status: TaskStatus,
  patch: Partial<TaskRecord> = {},
): Promise<TaskRecord> {
  const state = await readPlan(paths);
  const index = state.tasks.findIndex((entry) => entry.id === id);
  const existing = state.tasks[index];
  if (existing === undefined) {
    throw new NotFoundError(`Unknown task "${id}"`);
  }
  const updated: TaskRecord = {
    ...existing,
    ...patch,
    status,
    updatedAt: nowIso(),
  };
  state.tasks[index] = updated;
  await writePlan(paths, state);
  return updated;
}

export interface NextTaskResult {
  task: TaskRecord | null;
  blocked: TaskRecord[];
  reason: string;
}

/** Highest-priority actionable task whose dependencies are all satisfied. */
export async function selectNextTask(paths: ProjectPaths): Promise<NextTaskResult> {
  const tasks = await readTasks(paths);
  if (tasks.length === 0) {
    return { task: null, blocked: [], reason: 'The backlog is empty. Create a plan first.' };
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const open = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  const ready = open.filter((task) => blockedReason(task, byId) === null);
  const blocked = open.filter((task) => blockedReason(task, byId) !== null);

  if (ready.length === 0) {
    return {
      task: null,
      blocked,
      reason:
        blocked.length === 0
          ? 'No open tasks remain.'
          : 'All open tasks are waiting on dependencies. Resolve blockers or add a task.',
    };
  }

  ready.sort(
    (a, b) =>
      a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return {
    task: ready[0]!,
    blocked,
    reason: `Selected by priority (${ready[0]!.priority}); ${blocked.length} task(s) blocked by dependencies.`,
  };
}

export function taskProgress(tasks: TaskRecord[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}
