import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, type OpreConfig } from '../src/config.js';

export interface TestEnv {
  home: string;
  config: OpreConfig;
  cleanup: () => Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const home = await mkdtemp(join(tmpdir(), 'opre-test-'));
  const config = loadConfig({ OPRE_HOME: home, ...overrides });
  return {
    home: resolve(home),
    config,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function toolText(result: unknown): string {
  const callResult = result as { content?: Array<{ type: string; text?: string }> };
  const text = (callResult.content ?? [])
    .filter((entry) => entry.type === 'text')
    .map((entry) => entry.text ?? '')
    .join('\n');
  return text;
}

export function toolJson<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(toolText(result)) as T;
}
