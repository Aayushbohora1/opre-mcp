/**
 * Atomic JSON / markdown persistence for a single OPRE project directory.
 *
 * Writes go to a temporary file and are renamed into place, so a crashed write
 * never leaves a half-parsed project state behind. All paths are resolved inside
 * the project root (see `security/paths.ts`).
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpreError } from './errors.js';

export interface JsonFile<T> {
  schemaVersion: number;
  updatedAt: string;
  items: T;
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as T;
    }
    if (isRecord(parsed) && 'items' in parsed) {
      return (parsed as { items: unknown }).items as T;
    }
    return parsed as T;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return fallback;
    }
    throw new OpreError('io_error', `Failed to read ${path}: ${describe(error)}`, { cause: error });
  }
}

export async function writeJsonFile<T>(path: string, items: T, schemaVersion = 1): Promise<void> {
  const document: JsonFile<T> = {
    schemaVersion,
    updatedAt: new Date().toISOString(),
    items,
  };
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`);
}

export async function writeTextFileAtomic(path: string, contents: string): Promise<void> {
  await writeFileAtomic(path, contents);
}

export async function appendSection(path: string, heading: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const stamp = `- ${new Date().toISOString()}`;
  const entry = body.startsWith('\n') ? `${stamp}${body}\n` : `\n${stamp}\n\n${body}\n`;
  const existing = await readFileOrEmpty(path);
  const next = existing.includes(heading)
    ? `${existing}${entry}`
    : `${existing}\n${heading}\n${entry}`;
  await writeFileAtomic(path, next);
}

export async function ensureFile(path: string, contents: string): Promise<void> {
  const existing = await readFileOrEmpty(path);
  if (existing.length === 0) {
    await writeFileAtomic(path, contents);
  }
}

async function readFileOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return '';
    }
    throw new OpreError('io_error', `Failed to read ${path}: ${describe(error)}`, { cause: error });
  }
}

/** Writes a file atomically (temp file + rename), creating parent directories. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, contents, 'utf8');
    await rename(temp, path);
  } catch (error) {
    throw new OpreError('io_error', `Failed to write ${path}: ${describe(error)}`, {
      cause: error,
    });
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
