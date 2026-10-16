/**
 * Browser lifecycle for authorised research and validation.
 *
 * Launch order: explicit executable (`OPRE_BROWSER_EXECUTABLE`) → bundled
 * Chromium channel → default Playwright Chromium. Failures are surfaced as a
 * clear `unsupported_capability` error instead of an opaque stack trace.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { OpreConfig } from '../config.js';
import { UnsupportedCapabilityError } from '../core/errors.js';

export interface LaunchedBrowser {
  browser: Browser;
  launchOptions: Record<string, unknown>;
}

export async function launchBrowser(config: OpreConfig): Promise<LaunchedBrowser> {
  const attempts: Array<{ label: string; options: Parameters<typeof chromium.launch>[0] }> = [];

  if (config.browser.executablePath !== null) {
    attempts.push({
      label: `OPRE_BROWSER_EXECUTABLE=${config.browser.executablePath}`,
      options: { headless: config.browser.headless, executablePath: config.browser.executablePath },
    });
  }
  attempts.push({
    label: 'bundled chromium (full headless build)',
    options: { headless: config.browser.headless, channel: 'chromium' },
  });
  attempts.push({
    label: 'playwright default chromium',
    options: { headless: config.browser.headless },
  });

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options);
      return { browser, launchOptions: { label: attempt.label, ...attempt.options } };
    } catch (error) {
      failures.push(
        `${attempt.label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    }
  }

  throw new UnsupportedCapabilityError(
    'No usable Chromium build was found for browser automation.',
    {
      hint: 'Run "npx playwright install chromium" (needs network access), or set OPRE_BROWSER_EXECUTABLE to an existing Chromium binary. Page-level research that does not require a browser still works.',
      details: { attempts: failures },
    },
  );
}

export interface ContextOptions {
  userAgent: string;
  viewport: { width: number; height: number };
  /** Block every network request (used for local, already-running validation targets). */
  offline: boolean;
  ignoreHttpsErrors: boolean;
  recordHar: string | null;
}

export async function createContext(
  browser: Browser,
  options: ContextOptions,
): Promise<BrowserContext> {
  return browser.newContext({
    userAgent: options.userAgent,
    viewport: options.viewport,
    offline: options.offline,
    ignoreHTTPSErrors: options.ignoreHttpsErrors,
    javaScriptEnabled: true,
    serviceWorkers: 'block',
    ...(options.recordHar === null
      ? {}
      : { recordHar: { path: options.recordHar, content: 'omit' } }),
  });
}
