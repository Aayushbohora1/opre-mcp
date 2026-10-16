/** Validation-run persistence (`validation/runs.json`). */

import { appendSection, readJsonFile, writeJsonFile } from '../core/json-store.js';
import { nowIso } from '../core/ids.js';
import type { ProjectPaths } from '../project/paths.js';
import type { ValidationRunRecord } from './types.js';

export async function readRuns(paths: ProjectPaths): Promise<ValidationRunRecord[]> {
  return readJsonFile<ValidationRunRecord[]>(paths.runs, []);
}

export async function writeRuns(paths: ProjectPaths, runs: ValidationRunRecord[]): Promise<void> {
  await writeJsonFile(paths.runs, runs);
}

export async function appendRun(paths: ProjectPaths, run: ValidationRunRecord): Promise<void> {
  const runs = await readRuns(paths);
  runs.push(run);
  await writeRuns(paths, runs.slice(-200));
}

export async function appendKnownGaps(
  paths: ProjectPaths,
  entries: string[],
  runId: string,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const body = [`### Run ${runId} — ${nowIso()}`, '', ...entries.map((entry) => `- ${entry}`)].join(
    '\n',
  );
  await appendSection(paths.knownGaps, '## Validation gaps', body);
}
