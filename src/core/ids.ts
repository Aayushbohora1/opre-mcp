import { randomBytes, randomUUID } from 'node:crypto';

/** Short, sortable-enough identifier used for findings, features, tasks, runs. */
export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/** Full UUID, used for project identity. */
export function newProjectId(): string {
  return randomUUID();
}

/** ISO-8601 timestamp used across all persisted records. */
export function nowIso(): string {
  return new Date().toISOString();
}
