import { describe, expect, it } from 'vitest';
import {
  charLength,
  fitToBudget,
  lineExcerpt,
  paginate,
  truncateChars,
} from '../../src/core/limits.js';
import { OpreError, toToolError } from '../../src/core/errors.js';

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5];

  it('returns the requested window and reports the next offset', () => {
    const page = paginate(items, 0, 2, 10);
    expect(page.items).toEqual([1, 2]);
    expect(page).toMatchObject({
      total: 5,
      returned: 2,
      hasMore: true,
      nextOffset: 2,
      truncated: true,
    });
  });

  it('clamps the limit to the configured maximum', () => {
    const page = paginate(items, 0, 100, 3);
    expect(page.items).toHaveLength(3);
    expect(page.limit).toBe(3);
  });

  it('handles an out-of-range offset', () => {
    const page = paginate(items, 99, 2, 10);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});

describe('truncateChars', () => {
  it('marks truncation and reports both lengths', () => {
    const result = truncateChars('abcdefghij', 4);
    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(10);
    expect(result.text.startsWith('abcd')).toBe(true);
    expect(result.text).toContain('6 more characters');
  });

  it('is a no-op when it fits', () => {
    expect(truncateChars('abc', 10)).toEqual({
      text: 'abc',
      truncated: false,
      originalChars: 3,
      keptChars: 3,
    });
  });
});

describe('lineExcerpt', () => {
  const text = 'one\ntwo\nthree\nfour\nfive';

  it('extracts an inclusive line range', () => {
    expect(lineExcerpt(text, 2, 2)).toEqual({
      excerpt: 'two\nthree',
      startLine: 2,
      endLine: 3,
      totalLines: 5,
    });
  });

  it('clamps the start line to the document', () => {
    expect(lineExcerpt(text, 99, 3).startLine).toBe(5);
  });
});

describe('fitToBudget', () => {
  it('drops trailing list items until the payload fits', () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ id: index, blob: 'x'.repeat(50) }));
    const { payload, droppedItems, truncated } = fitToBudget({ items }, 'items', 1_000);
    expect(truncated).toBe(true);
    expect(droppedItems).toBeGreaterThan(0);
    expect(charLength(payload)).toBeLessThanOrEqual(1_000);
    expect((payload['items'] as unknown[]).length).toBeLessThan(50);
  });

  it('reports honestly when a single item still does not fit', () => {
    const { payload, truncated } = fitToBudget(
      { items: [{ blob: 'x'.repeat(5_000) }] },
      'items',
      100,
    );
    expect(truncated).toBe(true);
    expect(payload['omitted']).toBeTypeOf('string');
  });

  it('leaves small payloads untouched', () => {
    const result = fitToBudget({ items: [1, 2] }, 'items', 10_000);
    expect(result.truncated).toBe(false);
    expect(result.payload['items']).toEqual([1, 2]);
  });
});

describe('error handling', () => {
  it('serialises an OpreError into a structured tool error', () => {
    const error = new OpreError('not_found', 'missing thing', {
      hint: 'create it',
      details: { id: 7 },
    });
    const result = toToolError(error);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toEqual({
      error: 'not_found',
      message: 'missing thing',
      hint: 'create it',
      details: { id: 7 },
    });
  });

  it('never leaks a raw stack for unknown failures', () => {
    const result = toToolError(new Error('boom'));
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload['error']).toBe('internal_error');
    expect(String(payload['message'])).not.toContain('at Object');
  });
});
