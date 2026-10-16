/**
 * Runtime configuration, sourced from environment variables only.
 *
 * Every value is validated and clamped here so the rest of the codebase can
 * treat configuration as trusted. See README "Environment variables".
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ConfigError } from './core/errors.js';

export type TargetType = 'web' | 'app';

export interface OpreConfig {
  /** Parent directory that contains all OPRE projects. */
  homeDir: string;
  /** Hard ceiling for a single tool response, in characters. */
  maxResponseChars: number;
  /** Default number of list items returned by retrieval tools. */
  maxItems: number;
  /** Browser research limits. */
  research: {
    maxPages: number;
    maxDepth: number;
    timeoutMs: number;
    maxLinksPerPage: number;
    viewports: Array<{ name: string; width: number; height: number }>;
    userAgent: string;
    includeScreenshots: boolean;
    recordHar: boolean;
  };
  /** Web search adapter configuration. */
  search: {
    provider: 'none' | 'searxng';
    searxngUrl: string | null;
    maxResults: number;
    timeoutMs: number;
  };
  /** Browser launch configuration. */
  browser: {
    executablePath: string | null;
    headless: boolean;
  };
  /** Network policy. */
  network: {
    allowPrivateNetwork: boolean;
    maxDownloadBytes: number;
  };
  /** Generated-app runner / validation. */
  runner: {
    enabled: boolean;
    defaultPort: number;
    startTimeoutMs: number;
    requestTimeoutMs: number;
    maxValidationAttempts: number;
  };
  logLevel: 'silent' | 'error' | 'warn' | 'info';
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): OpreConfig {
  const homeDir = resolveHome(env);
  return {
    homeDir,
    maxResponseChars: readInt(env, 'OPRE_MAX_RESPONSE_CHARS', 24_000, 1_000, 2_000_000),
    maxItems: readInt(env, 'OPRE_MAX_ITEMS', 25, 1, 500),
    research: {
      maxPages: readInt(env, 'OPRE_RESEARCH_MAX_PAGES', 25, 1, 500),
      maxDepth: readInt(env, 'OPRE_RESEARCH_MAX_DEPTH', 2, 0, 10),
      timeoutMs: readInt(env, 'OPRE_RESEARCH_TIMEOUT_MS', 30_000, 1_000, 600_000),
      maxLinksPerPage: readInt(env, 'OPRE_RESEARCH_MAX_LINKS', 100, 1, 2_000),
      viewports: parseViewports(env.OPRE_RESEARCH_VIEWPORTS),
      userAgent:
        env.OPRE_USER_AGENT ??
        'Mozilla/5.0 (compatible; OPRE/0.1; +https://github.com/opre-mcp/opre-mcp) research-bot',
      includeScreenshots: readBool(env, 'OPRE_RESEARCH_SCREENSHOTS', true),
      recordHar: readBool(env, 'OPRE_RESEARCH_HAR', false),
    },
    search: {
      provider: readEnum(env, 'OPRE_WEB_SEARCH_PROVIDER', ['none', 'searxng'] as const, 'none'),
      searxngUrl: readOptionalUrl(env.OPRE_SEARXNG_URL),
      maxResults: readInt(env, 'OPRE_SEARCH_MAX_RESULTS', 8, 1, 50),
      timeoutMs: readInt(env, 'OPRE_SEARCH_TIMEOUT_MS', 20_000, 1_000, 120_000),
    },
    browser: {
      executablePath: env.OPRE_BROWSER_EXECUTABLE ?? null,
      headless: readBool(env, 'OPRE_BROWSER_HEADLESS', true),
    },
    network: {
      allowPrivateNetwork: readBool(env, 'OPRE_ALLOW_PRIVATE_NETWORK', false),
      maxDownloadBytes: readInt(env, 'OPRE_MAX_DOWNLOAD_BYTES', 25_000_000, 1_024, 500_000_000),
    },
    runner: {
      enabled: readBool(env, 'OPRE_RUNNER_ENABLED', true),
      defaultPort: readInt(env, 'OPRE_DEFAULT_PORT', 4173, 1, 65_535),
      startTimeoutMs: readInt(env, 'OPRE_SERVER_START_TIMEOUT_MS', 60_000, 1_000, 600_000),
      requestTimeoutMs: readInt(env, 'OPRE_VALIDATION_TIMEOUT_MS', 30_000, 1_000, 600_000),
      maxValidationAttempts: readInt(env, 'OPRE_MAX_VALIDATION_ATTEMPTS', 3, 1, 25),
    },
    logLevel: readEnum(
      env,
      'OPRE_LOG_LEVEL',
      ['silent', 'error', 'warn', 'info'] as const,
      'error',
    ),
  };
}

function resolveHome(env: Env): string {
  const raw = env.OPRE_HOME?.trim();
  if (raw !== undefined && raw.length > 0) {
    if (!isAbsolute(raw)) {
      throw new ConfigError(`OPRE_HOME must be an absolute path (received "${raw}")`);
    }
    return resolve(raw);
  }
  return resolve(homedir(), '.opre');
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${key} must be an integer (received "${raw}")`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max} (received ${parsed})`);
  }
  return parsed;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new ConfigError(`${key} must be a boolean (received "${raw}")`);
}

function readEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  if (!allowed.includes(raw.trim() as T)) {
    throw new ConfigError(`${key} must be one of ${allowed.join(', ')} (received "${raw}")`);
  }
  return raw.trim() as T;
}

function readOptionalUrl(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.toString();
  } catch {
    throw new ConfigError(`OPRE_SEARXNG_URL must be a valid http(s) URL (received "${raw}")`);
  }
}

function parseViewports(
  raw: string | undefined,
): Array<{ name: string; width: number; height: number }> {
  const defaults = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ];
  if (raw === undefined || raw.trim() === '') {
    return defaults;
  }
  const parsed = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, size] = entry.split(':');
      const parts = (size ?? '').split('x').map((value) => Number.parseInt(value, 10));
      const width = parts[0];
      const height = parts[1];
      if (name === undefined || name === '' || width === undefined || height === undefined) {
        throw new ConfigError(
          `OPRE_RESEARCH_VIEWPORTS entries must look like "name:WIDTHxHEIGHT" (received "${entry}")`,
        );
      }
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new ConfigError(`Invalid viewport dimensions in "${entry}"`);
      }
      return { name, width, height };
    });
  return parsed.length > 0 ? parsed : defaults;
}
