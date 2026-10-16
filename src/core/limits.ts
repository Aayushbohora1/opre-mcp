/**
 * Deterministic context-budget helpers.
 *
 * OPRE never promises token accounting: it enforces byte/character ceilings and
 * tells the caller exactly what was dropped so the agent can narrow its query.
 */

import { InvalidInputError } from './errors.js';

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  truncated: boolean;
}

export function paginate<T>(
  items: readonly T[],
  offset: number,
  limit: number,
  maxLimit: number,
): Page<T> {
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), maxLimit);
  const slice = items.slice(safeOffset, safeOffset + safeLimit);
  const hasMore = safeOffset + slice.length < items.length;
  return {
    items: slice,
    total: items.length,
    offset: safeOffset,
    limit: safeLimit,
    returned: slice.length,
    hasMore,
    nextOffset: hasMore ? safeOffset + slice.length : null,
    truncated: hasMore,
  };
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  keptChars: number;
}

export function truncateChars(text: string, maxChars: number): TruncateResult {
  if (maxChars <= 0) {
    throw new InvalidInputError('maxChars must be greater than 0');
  }
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length, keptChars: text.length };
  }
  return {
    text: `${text.slice(0, maxChars)}\n[...truncated: ${text.length - maxChars} more characters]`,
    truncated: true,
    originalChars: text.length,
    keptChars: maxChars,
  };
}

/** Line-anchored excerpt: keeps `startLine`..`startLine+maxLines` (1-based). */
export function lineExcerpt(
  text: string,
  startLine: number,
  maxLines: number,
): { excerpt: string; startLine: number; endLine: number; totalLines: number } {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const start = Math.min(Math.max(1, Math.trunc(startLine)), Math.max(totalLines, 1));
  const end = Math.min(totalLines, start + Math.max(1, Math.trunc(maxLines)) - 1);
  const excerpt = lines.slice(start - 1, end).join('\n');
  return { excerpt, startLine: start, endLine: end, totalLines };
}

/**
 * Drops trailing array items until the payload fits the character budget.
 * Returns the payload plus an honest report of what was removed.
 */
export function fitToBudget(
  payload: Record<string, unknown>,
  listKey: string,
  maxChars: number,
): { payload: Record<string, unknown>; droppedItems: number; truncated: boolean } {
  const list = payload[listKey];
  if (!Array.isArray(list)) {
    const text = JSON.stringify(payload);
    if (text.length <= maxChars) {
      return { payload, droppedItems: 0, truncated: false };
    }
    const nonListKeys = Object.keys(payload);
    return {
      payload: {
        omitted: `Response exceeded the ${maxChars} character budget. Narrow the query or raise OPRE_MAX_RESPONSE_CHARS.`,
        keys: nonListKeys.slice(0, 20),
      },
      droppedItems: nonListKeys.length,
      truncated: true,
    };
  }

  const items: unknown[] = [...(list as unknown[])];
  let working: Record<string, unknown> = { ...payload, [listKey]: items };
  let dropped = 0;
  while (JSON.stringify(working).length > maxChars && (working[listKey] as unknown[]).length > 1) {
    const current = working[listKey] as unknown[];
    current.pop();
    working = { ...working, [listKey]: [...current] };
    dropped += 1;
  }

  if (JSON.stringify(working).length <= maxChars) {
    return { payload: working, droppedItems: dropped, truncated: dropped > 0 };
  }

  return {
    payload: {
      omitted: `Response exceeded the ${maxChars} character budget; narrow the query or raise OPRE_MAX_RESPONSE_CHARS.`,
      [listKey]: items.slice(0, 1),
    },
    droppedItems: items.length - 1,
    truncated: true,
  };
}

export function charLength(value: unknown): number {
  return JSON.stringify(value ?? null).length;
}
