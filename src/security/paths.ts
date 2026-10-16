/**
 * Path containment. Every project-relative path goes through here so that a
 * malicious `../` sequence, an absolute path, or a symlink can never make OPRE
 * write outside the project directory.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SecurityError } from '../core/errors.js';

export function resolveInside(root: string, candidate: string): string {
  if (candidate.length === 0) {
    throw new SecurityError('Empty path is not allowed');
  }
  if (candidate.includes('\0')) {
    throw new SecurityError('Path contains a null byte');
  }
  if (isAbsolute(candidate) || /^[a-zA-Z]:/.test(candidate)) {
    throw new SecurityError(`Absolute paths are not allowed inside a project: ${candidate}`);
  }
  const rootResolved = resolve(root);
  const target = resolve(rootResolved, candidate);
  const rel = relative(rootResolved, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new SecurityError(`Path escapes the project directory: ${candidate}`);
  }
  return target;
}

/** Guards against symlinks that point outside the project directory. */
export async function assertNoSymlinkEscape(root: string, target: string): Promise<void> {
  const rootReal = await realpathOrSelf(root);
  let current = target;
  // Walk up to the nearest existing ancestor, then verify it stays inside root.
  for (;;) {
    try {
      const real = await realpath(current);
      const rel = relative(rootReal, real);
      if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
        throw new SecurityError(
          `Resolved path escapes the project directory: ${candidateLabel(target)}`,
        );
      }
      return;
    } catch (error) {
      if (error instanceof SecurityError) {
        throw error;
      }
      const parent = resolve(current, '..');
      if (parent === current || current.length <= rootReal.length) {
        return;
      }
      current = parent;
    }
  }
}

function candidateLabel(target: string): string {
  const parts = target.split(sep);
  return parts.slice(-3).join(sep);
}

async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/** Validates a project-relative id used as a filename segment (e.g. `task_1a2b`). */
export function assertSafeSegment(segment: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment)) {
    throw new SecurityError(
      `Invalid ${label} "${segment}". Use letters, digits, dot, dash or underscore (max 64 characters).`,
    );
  }
  return segment;
}
