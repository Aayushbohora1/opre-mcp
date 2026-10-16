/**
 * Fidelity: how close is the rebuild to the reference?
 *
 * The score is an F1 over structural sections (precision and recall both matter:
 * missing content *and* invented content are defects), plus a visual delta when
 * both screenshots exist. Every difference is named, so "82% match" is
 * actionable rather than a vibe.
 */

import { readFile } from 'node:fs/promises';
import type { PageFingerprint } from '../research/fingerprint.js';
import { compareImages, type VisualDiffResult } from './image-diff.js';

export interface FidelitySection {
  name: string;
  score: number;
  matched: number;
  reference: number;
  rebuilt: number;
}

export interface FidelityReport {
  route: string;
  referenceUrl: string | null;
  rebuiltUrl: string | null;
  /** 0-1, weighted across sections. */
  score: number;
  verdict: 'match' | 'close' | 'partial' | 'divergent';
  sections: FidelitySection[];
  differences: string[];
  visual: VisualDiffResult;
  screenshots: { reference: string | null; rebuilt: string | null };
}

const WEIGHTS: Record<string, number> = {
  headings: 0.3,
  text: 0.25,
  links: 0.15,
  forms: 0.1,
  interactive: 0.1,
  tokens: 0.05,
  visual: 0.05,
};

export interface DiffOptions {
  referenceScreenshotPath?: string | null;
  rebuiltScreenshotPath?: string | null;
  maxDifferences?: number;
}

export async function diffFingerprints(
  reference: PageFingerprint,
  rebuilt: PageFingerprint,
  options: DiffOptions = {},
): Promise<FidelityReport> {
  const maxDifferences = options.maxDifferences ?? 25;
  const differences: string[] = [];

  const sections: FidelitySection[] = [
    compareSet(
      'headings',
      reference.headings.map((heading) => `h${heading.level}:${heading.text}`),
      rebuilt.headings.map((heading) => `h${heading.level}:${heading.text}`),
      differences,
      maxDifferences,
    ),
    compareSet('text', reference.textBlocks, rebuilt.textBlocks, differences, maxDifferences),
    compareSet('links', reference.links, rebuilt.links, differences, maxDifferences),
    compareSet(
      'forms',
      reference.forms.map((form) => form.signature),
      rebuilt.forms.map((form) => form.signature),
      differences,
      maxDifferences,
    ),
    compareSet(
      'interactive',
      reference.interactive,
      rebuilt.interactive,
      differences,
      maxDifferences,
    ),
    compareSet(
      'tokens',
      [
        ...reference.tokens.colors.map((entry) => `color:${entry}`),
        ...reference.tokens.fontFamilies.map((entry) => `font:${entry}`),
        ...reference.tokens.fontSizes.map((entry) => `size:${entry}`),
      ],
      [
        ...rebuilt.tokens.colors.map((entry) => `color:${entry}`),
        ...rebuilt.tokens.fontFamilies.map((entry) => `font:${entry}`),
        ...rebuilt.tokens.fontSizes.map((entry) => `size:${entry}`),
      ],
      differences,
      maxDifferences,
    ),
  ];

  if (reference.landmarks.join(',') !== rebuilt.landmarks.join(',')) {
    const missing = reference.landmarks.filter((entry) => !rebuilt.landmarks.includes(entry));
    const extra = rebuilt.landmarks.filter((entry) => !reference.landmarks.includes(entry));
    push(
      differences,
      maxDifferences,
      `landmarks: missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'}`,
    );
  }

  const visual = await compareScreenshots(
    options.referenceScreenshotPath ?? reference.screenshotPath,
    options.rebuiltScreenshotPath ?? rebuilt.screenshotPath,
  );
  sections.push({
    name: 'visual',
    score: visual.compared ? visual.score : 0,
    matched: visual.compared ? visual.totalCells - visual.differingCells : 0,
    reference: visual.totalCells,
    rebuilt: visual.totalCells,
  });

  const totalWeight = sections.reduce((sum, section) => sum + (WEIGHTS[section.name] ?? 0), 0);
  const score =
    totalWeight === 0
      ? 0
      : sections.reduce((sum, section) => sum + (WEIGHTS[section.name] ?? 0) * section.score, 0) /
        totalWeight;

  return {
    route: reference.route,
    referenceUrl: null,
    rebuiltUrl: null,
    score: round(score),
    verdict: verdictFor(score),
    sections: sections.map((section) => ({ ...section, score: round(section.score) })),
    differences: differences.slice(0, maxDifferences),
    visual,
    screenshots: {
      reference: options.referenceScreenshotPath ?? reference.screenshotPath,
      rebuilt: options.rebuiltScreenshotPath ?? rebuilt.screenshotPath,
    },
  };
}

/** Routes present in the reference but absent from the rebuild, and vice versa. */
export function diffRouteSets(
  referenceRoutes: string[],
  rebuiltRoutes: string[],
): { missing: string[]; extra: string[] } {
  const rebuilt = new Set(rebuiltRoutes);
  const reference = new Set(referenceRoutes);
  return {
    missing: referenceRoutes.filter((route) => !rebuilt.has(route)),
    extra: rebuiltRoutes.filter((route) => !reference.has(route)),
  };
}

export interface FidelitySummary {
  routesCompared: number;
  averageScore: number;
  match: number;
  close: number;
  partial: number;
  divergent: number;
  missingRoutes: string[];
  extraRoutes: string[];
  routes: Array<{ route: string; score: number; verdict: string; topDifferences: string[] }>;
}

export function summariseFidelity(
  reports: FidelityReport[],
  routes: { missing: string[]; extra: string[] },
): FidelitySummary {
  const average =
    reports.length === 0
      ? 0
      : reports.reduce((sum, report) => sum + report.score, 0) / reports.length;
  return {
    routesCompared: reports.length,
    averageScore: round(average),
    match: reports.filter((report) => report.verdict === 'match').length,
    close: reports.filter((report) => report.verdict === 'close').length,
    partial: reports.filter((report) => report.verdict === 'partial').length,
    divergent: reports.filter((report) => report.verdict === 'divergent').length,
    missingRoutes: routes.missing,
    extraRoutes: routes.extra,
    routes: reports.map((report) => ({
      route: report.route,
      score: report.score,
      verdict: report.verdict,
      topDifferences: report.differences.slice(0, 3),
    })),
  };
}

function compareSet(
  name: string,
  reference: string[],
  rebuilt: string[],
  differences: string[],
  maxDifferences: number,
): FidelitySection {
  const referenceSet = new Set(reference);
  const rebuiltSet = new Set(rebuilt);
  const matched = [...referenceSet].filter((value) => rebuiltSet.has(value));
  const missing = [...referenceSet].filter((value) => !rebuiltSet.has(value));
  const extra = [...rebuiltSet].filter((value) => !referenceSet.has(value));

  for (const value of missing.slice(0, 8)) {
    push(differences, maxDifferences, `${name}: missing "${clip(value)}"`);
  }
  if (missing.length > 8) {
    push(differences, maxDifferences, `${name}: …and ${missing.length - 8} more missing`);
  }
  for (const value of extra.slice(0, 5)) {
    push(differences, maxDifferences, `${name}: unexpected "${clip(value)}"`);
  }

  const precision =
    rebuiltSet.size === 0 ? (referenceSet.size === 0 ? 1 : 0) : matched.length / rebuiltSet.size;
  const recall = referenceSet.size === 0 ? 1 : matched.length / referenceSet.size;
  return {
    name,
    score: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    matched: matched.length,
    reference: referenceSet.size,
    rebuilt: rebuiltSet.size,
  };
}

async function compareScreenshots(
  reference: string | null,
  rebuilt: string | null,
): Promise<VisualDiffResult> {
  const [a, b] = await Promise.all([readIfPresent(reference), readIfPresent(rebuilt)]);
  return compareImages(a, b);
}

async function readIfPresent(path: string | null): Promise<Buffer | null> {
  if (path === null) {
    return null;
  }
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function push(target: string[], limit: number, message: string): void {
  if (target.length < limit) {
    target.push(message);
  }
}

function verdictFor(score: number): FidelityReport['verdict'] {
  if (score >= 0.95) return 'match';
  if (score >= 0.8) return 'close';
  if (score >= 0.5) return 'partial';
  return 'divergent';
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clip(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
