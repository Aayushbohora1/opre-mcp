/**
 * Turns stored research records into the two human-readable reports
 * (`research/overview.md` and `research/architecture.md`).
 *
 * Reports are regenerated into marked sections so operator edits are preserved,
 * and they always link back to finding ids instead of inlining the corpus.
 */

import { nowIso } from '../core/ids.js';
import { upsertGeneratedSection } from '../core/markdown.js';
import type { ProjectPaths } from '../project/paths.js';
import type { ProjectManifest } from '../project/types.js';
import type { FindingRecord, PageRecord, SourceRecord } from './types.js';

export interface ReportInput {
  manifest: ProjectManifest;
  pages: PageRecord[];
  findings: FindingRecord[];
  sources: SourceRecord[];
  notes: string[];
  blockedRequests: string[];
  errors: string[];
  screenshotCount: number;
  searchProvider: string;
}

export async function writeResearchReports(paths: ProjectPaths, input: ReportInput): Promise<void> {
  await upsertGeneratedSection(paths.overview, buildOverview(input));
  await upsertGeneratedSection(paths.architecture, buildArchitecture(input));
}

function buildOverview(input: ReportInput): string {
  const { manifest, pages, findings } = input;
  const byKind = {
    observed: findings.filter((finding) => finding.kind === 'observed').length,
    derived: findings.filter((finding) => finding.kind === 'derived').length,
    hypothesis: findings.filter((finding) => finding.kind === 'hypothesis').length,
  };
  const lines: string[] = [];
  lines.push(`_Generated ${nowIso()} by OPRE. Do not edit inside the generated markers._`);
  lines.push('');
  lines.push(`## Target`);
  lines.push('');
  lines.push(`- URL: ${manifest.target}`);
  lines.push(`- Type: ${manifest.targetType}`);
  lines.push(`- Authorisation: ${manifest.authorisation}`);
  lines.push(`- Pages inspected: ${pages.length} (screenshots: ${input.screenshotCount})`);
  lines.push(
    `- Findings: ${findings.length} (observed ${byKind.observed}, derived ${byKind.derived}, hypothesis ${byKind.hypothesis})`,
  );
  lines.push(`- Sources: ${input.sources.length}`);
  lines.push(`- Web search: ${input.searchProvider}`);
  lines.push('');
  lines.push(`## Route inventory`);
  lines.push('');
  if (pages.length === 0) {
    lines.push('_No pages were captured._');
  } else {
    lines.push('| URL | Title | Depth | HTTP | Forms | Interactive | Screenshot |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const page of pages.slice(0, 60)) {
      lines.push(
        `| ${page.url} | ${escapeCell(page.title)} | ${page.depth} | ${page.httpStatus ?? 'n/a'} | ${page.forms.length} | ${page.interactive.length} | ${page.screenshotPath ?? '—'} |`,
      );
    }
  }
  lines.push('');
  lines.push(`## Findings index`);
  lines.push('');
  lines.push('| id | kind | verification | statement |');
  lines.push('| --- | --- | --- | --- |');
  for (const finding of findings.slice(0, 60)) {
    lines.push(
      `| ${finding.id} | ${finding.kind} | ${finding.verification} | ${escapeCell(finding.statement, 160)} |`,
    );
  }
  if (input.errors.length > 0) {
    lines.push('');
    lines.push(`## Collection errors`);
    lines.push('');
    for (const error of input.errors.slice(0, 20)) {
      lines.push(`- ${error}`);
    }
  }
  if (input.blockedRequests.length > 0) {
    lines.push('');
    lines.push(`## Blocked requests (out of scope for this project)`);
    lines.push('');
    for (const blocked of input.blockedRequests.slice(0, 20)) {
      lines.push(`- ${blocked}`);
    }
  }
  if (input.notes.length > 0) {
    lines.push('');
    lines.push(`## Operator notes`);
    lines.push('');
    for (const note of input.notes) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join('\n');
}

function buildArchitecture(input: ReportInput): string {
  const { pages } = input;
  const technologies = dedupe(
    pages.flatMap((page) => page.technologies.map((tech) => tech.replace(/^generator: /, ''))),
  );
  const sharedLayouts = findRepeatedStrings(
    pages.map((page) => page.headings),
    2,
  );
  const lines: string[] = [];
  lines.push(`_Generated ${nowIso()} by OPRE. Inferences only — verify before adopting._`);
  lines.push('');
  lines.push(`## Observed technology signals`);
  lines.push('');
  lines.push(
    technologies.length === 0
      ? '_No technology signals detected._'
      : technologies.map((tech) => `- ${tech}`).join('\n'),
  );
  lines.push('');
  lines.push(`## Navigation model`);
  lines.push('');
  lines.push(`- Publicly reachable routes observed: ${pages.length}`);
  lines.push(
    `- Internal links discovered: ${pages.reduce((sum, page) => sum + page.links.filter((link) => link.internal).length, 0)}`,
  );
  lines.push(`- Forms discovered: ${pages.reduce((sum, page) => sum + page.forms.length, 0)}`);
  lines.push('');
  if (sharedLayouts.length > 0) {
    lines.push(`## Repeated section headings (possible shared layout / navigation)`);
    lines.push('');
    for (const heading of sharedLayouts.slice(0, 15)) {
      lines.push(`- ${heading}`);
    }
    lines.push('');
  }
  lines.push(`## What this report cannot tell you`);
  lines.push('');
  lines.push('- Server-side implementation, APIs and data models.');
  lines.push('- Behaviour behind authentication, paywalls, or user interaction.');
  lines.push(
    '- Anything the crawl limits excluded (see the run limits in opre.get_research_summary).',
  );
  return lines.join('\n');
}

function findRepeatedStrings(groups: string[][], minimumOccurrences: number): string[] {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const value of new Set(group)) {
      if (value.length < 3 || value.length > 80) {
        continue;
      }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minimumOccurrences)
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeCell(value: string, maxChars = 80): string {
  const cleaned = value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`;
}
