/**
 * Markdown helpers that never destroy operator-authored content.
 *
 * Generated blocks are delimited by HTML comment markers; a block is replaced in
 * place on regeneration, and anything outside the markers is left untouched.
 */

import { readFile } from 'node:fs/promises';

export const GENERATED_BEGIN = '<!-- opre:generated:begin -->';
export const GENERATED_END = '<!-- opre:generated:end -->';

export interface UpsertResult {
  action: 'created' | 'replaced' | 'appended';
}

export async function upsertGeneratedSection(path: string, body: string): Promise<UpsertResult> {
  const block = `${GENERATED_BEGIN}\n${body.trimEnd()}\n${GENERATED_END}\n`;
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    existing = null;
  }

  if (existing === null || existing.trim() === '') {
    await writeText(path, block);
    return { action: 'created' };
  }

  const beginIndex = existing.indexOf(GENERATED_BEGIN);
  const endIndex = existing.indexOf(GENERATED_END);

  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    const next = `${existing.slice(0, beginIndex)}${block}${existing.slice(endIndex + GENERATED_END.length + 1)}`;
    await writeText(path, next);
    return { action: 'replaced' };
  }

  await writeText(path, `${existing.trimEnd()}\n\n${block}`);
  return { action: 'appended' };
}

export function replaceGeneratedSection(existing: string, body: string): string {
  const block = `${GENERATED_BEGIN}\n${body.trimEnd()}\n${GENERATED_END}\n`;
  const beginIndex = existing.indexOf(GENERATED_BEGIN);
  const endIndex = existing.indexOf(GENERATED_END);
  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    return `${existing.slice(0, beginIndex)}${block}${existing.slice(endIndex + GENERATED_END.length + 1)}`;
  }
  return `${existing.trimEnd()}\n\n${block}`;
}

async function writeText(path: string, contents: string): Promise<void> {
  const { writeFileAtomic } = await import('./json-store.js');
  await writeFileAtomic(path, contents);
}
