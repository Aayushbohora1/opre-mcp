/** Implementation-result persistence (`artifacts/reports/build-results.json`). */

import { readJsonFile, writeJsonFile } from '../core/json-store.js';
import type { ProjectPaths } from '../project/paths.js';
import type { BuildResultRecord } from './types.js';

const BUILD_RESULTS_RELATIVE = 'artifacts/reports/build-results.json';

export async function readBuildResults(paths: ProjectPaths): Promise<BuildResultRecord[]> {
  return readJsonFile<BuildResultRecord[]>(`${paths.root}/${BUILD_RESULTS_RELATIVE}`, []);
}

export async function writeBuildResults(
  paths: ProjectPaths,
  results: BuildResultRecord[],
): Promise<void> {
  await writeJsonFile(`${paths.root}/${BUILD_RESULTS_RELATIVE}`, results);
}
