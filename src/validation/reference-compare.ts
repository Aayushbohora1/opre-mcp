/**
 * Reference comparison: measure the rebuild against the target it was built from.
 *
 * When a project has researched pages with fingerprints, a validation run can
 * capture the same fingerprints from the running app and diff them. The result is
 * a per-route fidelity score plus the concrete differences, stored on the run and
 * summarised in the report — so "it looks right" becomes a number with evidence.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpreConfig } from '../config.js';
import { resolveInside } from '../security/paths.js';
import { installTransformShim, launchBrowser } from '../research/browser.js';
import { captureFingerprint, type PageFingerprint } from '../research/fingerprint.js';
import { readPages } from '../research/store.js';
import type { ProjectPaths } from '../project/paths.js';
import type { PageRecord } from '../research/types.js';
import {
  diffFingerprints,
  diffRouteSets,
  summariseFidelity,
  type FidelityReport,
  type FidelitySummary,
} from './fidelity.js';

export interface ReferenceComparisonOptions {
  baseUrl: string;
  maxRoutes: number;
  saveScreenshots: boolean;
  screenshotDir: string;
  startPaths: string[];
}

export interface ReferenceComparison {
  reports: FidelityReport[];
  summary: FidelitySummary;
  /** Routes in the reference with no fingerprint captured (older research runs). */
  skipped: number;
}

export async function compareWithReference(
  config: OpreConfig,
  paths: ProjectPaths,
  options: ReferenceComparisonOptions,
): Promise<ReferenceComparison> {
  const pages = await readPages(paths);
  const references = pages.filter(
    (page): page is PageRecord & { fingerprint: NonNullable<PageRecord['fingerprint']> } =>
      page.fingerprint !== null && (page.httpStatus === null || page.httpStatus < 400),
  );

  if (references.length === 0) {
    return {
      reports: [],
      skipped: pages.length,
      summary: summariseFidelity([], { missing: [], extra: [] }),
    };
  }

  const { browser } = await launchBrowser(config);
  const reports: FidelityReport[] = [];
  const rebuiltRoutes: string[] = [];
  let skipped = 0;

  try {
    if (options.saveScreenshots) {
      await mkdir(options.screenshotDir, { recursive: true });
    }
    const context = await browser.newContext({
      userAgent: config.research.userAgent,
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    await installTransformShim(page);

    for (const reference of references.slice(0, options.maxRoutes)) {
      const wanted = wantedPath(reference.fingerprint.route, options.startPaths);
      if (wanted === null) {
        skipped += 1;
        continue;
      }
      try {
        const response = await page.goto(new URL(wanted, options.baseUrl).toString(), {
          waitUntil: 'domcontentloaded',
          timeout: config.runner.requestTimeoutMs,
        });
        if (response !== null && response.status() >= 400) {
          skipped += 1;
          continue;
        }
        const raw = await captureFingerprint(page);
        let screenshotPath: string | null = null;
        if (options.saveScreenshots) {
          const fileName = `fidelity-${sanitize(reference.fingerprint.route)}.png`;
          await page
            .screenshot({ path: join(options.screenshotDir, fileName), fullPage: false })
            .then(() => {
              screenshotPath = fileName;
            })
            .catch(() => {
              screenshotPath = null;
            });
        }
        const rebuiltFingerprint: PageFingerprint = {
          ...raw,
          screenshotPath,
          capturedAt: new Date().toISOString(),
        };
        rebuiltRoutes.push(rebuiltFingerprint.route);

        const report = await diffFingerprints(
          {
            ...(reference.fingerprint as PageFingerprint),
            screenshotPath:
              reference.screenshotPath === null
                ? null
                : join(paths.screenshots, reference.screenshotPath),
            capturedAt: reference.collectedAt,
          },
          rebuiltFingerprint,
        );
        report.referenceUrl = reference.url;
        report.rebuiltUrl = new URL(wanted, options.baseUrl).toString();
        reports.push(report);
      } catch {
        skipped += 1;
      }
    }

    await context.close().catch(() => undefined);
  } finally {
    await browser.close().catch(() => undefined);
  }

  const routeDiff = diffRouteSets(
    references.map((reference) => reference.fingerprint.route),
    rebuiltRoutes,
  );

  return { reports, summary: summariseFidelity(reports, routeDiff), skipped };
}

/** The rebuild serves its own routes; the reference route tells us which to ask for. */
function wantedPath(referenceRoute: string, startPaths: string[]): string | null {
  if (referenceRoute === '/' || referenceRoute === '') {
    return startPaths.includes('/') || startPaths.length === 0 ? '/' : startPaths[0]!;
  }
  return referenceRoute;
}

function sanitize(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^-+/, '')
      .slice(0, 60) || 'root'
  );
}

export { resolveInside };
