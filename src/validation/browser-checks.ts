/**
 * Browser-based acceptance checks against the generated application.
 *
 * Checks are declarative (see `BrowserCheckSpec`): they navigate, assert text or
 * visibility, interact, and capture screenshots. Every check records what was
 * expected, what was observed, and how long it took, so a failure is actionable.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { createContext, launchBrowser } from '../research/browser.js';
import type { OpreConfig } from '../config.js';
import { shortId } from '../core/ids.js';
import { truncateChars } from '../core/limits.js';
import { resolveInside } from '../security/paths.js';
import type { ProjectPaths } from '../project/paths.js';
import type { BrowserCheckSpec, TaskRecord } from '../planning/types.js';
import type { CheckResult } from './types.js';

export interface CheckRunOptions {
  baseUrl: string;
  checks: BrowserCheckSpec[];
  screenshotDir: string;
  timeoutMs: number;
  saveScreenshots: boolean;
}

export interface CheckRunOutcome {
  results: CheckResult[];
  screenshots: string[];
  consoleErrors: string[];
  failedRequests: string[];
  browserLaunch: string;
}

export function defaultChecks(startPath: string): BrowserCheckSpec[] {
  return [
    {
      id: 'homepage-loads',
      description: 'The application root responds and renders a page',
      kind: 'navigate',
      target: startPath,
      expected: null,
      screenshot: 'root',
    },
  ];
}

export async function runBrowserChecks(
  config: OpreConfig,
  paths: ProjectPaths,
  options: CheckRunOptions,
): Promise<CheckRunOutcome> {
  const { browser, launchOptions } = await launchBrowser(config);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const screenshots: string[] = [];
  const results: CheckResult[] = [];

  if (options.saveScreenshots) {
    await mkdir(options.screenshotDir, { recursive: true });
  }

  const context: BrowserContext = await createContext(browser, {
    userAgent: config.research.userAgent,
    viewport: { width: 1280, height: 800 },
    offline: false,
    ignoreHttpsErrors: false,
    recordHar: null,
  });
  const page: Page = await context.newPage();

  page.on('console', (message) => {
    if (message.type() === 'error' && consoleErrors.length < 25) {
      consoleErrors.push(truncateChars(message.text(), 300).text);
    }
  });
  page.on('requestfailed', (request) => {
    if (failedRequests.length < 25) {
      failedRequests.push(
        truncateChars(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`, 300).text,
      );
    }
  });

  try {
    for (const check of options.checks) {
      results.push(await runCheck(page, check, options, screenshots));
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  return {
    results,
    screenshots,
    consoleErrors,
    failedRequests,
    browserLaunch: String(launchOptions.label),
  };
}

async function runCheck(
  page: Page,
  check: BrowserCheckSpec,
  options: CheckRunOptions,
  screenshots: string[],
): Promise<CheckResult> {
  const started = Date.now();
  const base: CheckResult = {
    id: check.id,
    description: check.description,
    status: 'failed',
    expected: check.expected,
    observed: null,
    durationMs: 0,
    screenshotPath: null,
    error: null,
  };

  try {
    const url = toUrl(check, options.baseUrl);
    let observed = '';
    let navigationStatus: number | null = null;
    switch (check.kind) {
      case 'navigate': {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: options.timeoutMs,
        });
        navigationStatus = response?.status() ?? null;
        observed = `HTTP ${response?.status() ?? 'n/a'}, title="${await page.title()}"`;
        break;
      }
      case 'assert_text': {
        await ensureLoaded(page, url, options);
        observed = (await page.textContent('body')) ?? '';
        const needle = check.expected ?? check.target ?? '';
        const found = observed.toLowerCase().includes(needle.toLowerCase());
        return finish(
          base,
          found,
          `contains "${needle}"`,
          started,
          page,
          check,
          options,
          screenshots,
        );
      }
      case 'assert_visible': {
        await ensureLoaded(page, url, options);
        const locator = page.locator(check.target ?? 'body').first();
        const visible = await locator.isVisible();
        observed = `${check.target} visible=${visible}`;
        return finish(
          base,
          visible,
          `${check.target} visible`,
          started,
          page,
          check,
          options,
          screenshots,
        );
      }
      case 'click': {
        await ensureLoaded(page, url, options);
        await page
          .locator(check.target ?? 'body')
          .first()
          .click({ timeout: options.timeoutMs });
        observed = 'clicked';
        break;
      }
      case 'fill': {
        await ensureLoaded(page, url, options);
        await page
          .locator(check.target ?? 'input')
          .first()
          .fill(check.expected ?? '');
        observed = `filled ${check.target}`;
        break;
      }
      case 'screenshot': {
        await ensureLoaded(page, url, options);
        observed = 'captured';
        break;
      }
    }

    // A navigation check only passes when the route actually served the request.
    const navigational = check.kind === 'navigate';
    const passed = navigational ? navigationStatus !== null && navigationStatus < 400 : true;
    return finish(
      base,
      passed,
      check.expected ?? 'no error',
      started,
      page,
      check,
      options,
      screenshots,
      observed,
    );
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error:
        error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ') : String(error),
      durationMs: Date.now() - started,
    };
  }
}

async function ensureLoaded(page: Page, url: string, options: CheckRunOptions): Promise<void> {
  if (page.url() !== url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
  }
}

async function finish(
  base: CheckResult,
  passed: boolean,
  observed: string,
  started: number,
  page: Page,
  check: BrowserCheckSpec,
  options: CheckRunOptions,
  screenshots: string[],
  observedOverride?: string,
): Promise<CheckResult> {
  let screenshotPath: string | null = null;
  if (check.screenshot !== null && options.saveScreenshots) {
    const fileName = `${shortId('shot')}-${sanitize(check.screenshot)}.png`;
    try {
      await page.screenshot({ path: join(options.screenshotDir, fileName), fullPage: false });
      screenshotPath = fileName;
      screenshots.push(fileName);
    } catch {
      screenshotPath = null;
    }
  }
  return {
    ...base,
    status: passed ? 'passed' : 'failed',
    observed: truncateChars(observedOverride ?? observed, 400).text,
    durationMs: Date.now() - started,
    screenshotPath,
  };
}

function toUrl(check: BrowserCheckSpec, baseUrl: string): string {
  const target = check.target ?? '/';
  return new URL(target.startsWith('/') ? target : `/${target}`, baseUrl).toString();
}

export function assertCheckKind(value: string): BrowserCheckSpec['kind'] {
  const allowed: BrowserCheckSpec['kind'][] = [
    'navigate',
    'assert_text',
    'assert_visible',
    'click',
    'fill',
    'screenshot',
  ];
  if (!allowed.includes(value as BrowserCheckSpec['kind'])) {
    throw new Error(`Unsupported check kind "${value}". Allowed: ${allowed.join(', ')}`);
  }
  return value as BrowserCheckSpec['kind'];
}

export function checksForTask(task: TaskRecord | null, startPath: string): BrowserCheckSpec[] {
  if (task === null) {
    return defaultChecks(startPath);
  }
  return task.validation.checks.length > 0 ? task.validation.checks : defaultChecks(startPath);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
}

export function screenshotPathFor(projectRoot: string, fileName: string): string {
  return resolveInside(projectRoot, `artifacts/screenshots/${sanitize(fileName)}`);
}
