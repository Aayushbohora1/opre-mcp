/**
 * Website research crawler.
 *
 * Behaviour contract:
 *  - only pages on the target host are visited (plus explicitly allowed hosts);
 *  - every request is filtered, so private/loopback destinations are unreachable
 *    unless the operator opted in;
 *  - captured text is treated as untrusted evidence and scanned for injected
 *    instructions, which become findings instead of silent content;
 *  - results are stored as provenance-carrying records, never as prose dumps.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { OpreConfig } from '../config.js';
import { ResearchError } from '../core/errors.js';
import { nowIso, shortId } from '../core/ids.js';
import type { ProjectPaths } from '../project/paths.js';
import type { ProjectManifest } from '../project/types.js';
import { resolveInside } from '../security/paths.js';
import { scanForInjection } from '../security/untrusted.js';
import { hostMatches, isLoopbackHost, parseUrl } from '../security/url.js';
import { createContext, installTransformShim, launchBrowser } from './browser.js';
import { newPageRecord, newSourceRecord } from './store.js';
import type { FindingRecord, FingerprintRecord, PageRecord, SourceRecord } from './types.js';
import { captureFingerprint } from './fingerprint.js';
import { captureStyleAndAria } from './reference-pack.js';

export interface ResearchProgress {
  report: (message: string, progress?: number, total?: number) => void | Promise<void>;
}

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  /** How many pages to inspect at once. */
  concurrency: number;
  timeoutMs: number;
  maxLinksPerPage: number;
  includeScreenshots: boolean;
  recordHar: boolean;
  viewport: { width: number; height: number };
  extraPaths: string[];
  notes: string[];
}

export interface CrawlOutcome {
  pages: PageRecord[];
  sources: SourceRecord[];
  findings: FindingRecord[];
  run: {
    id: string;
    startedAt: string;
    finishedAt: string;
    target: string;
    pagesVisited: number;
    maxDepthReached: number;
    limits: { maxPages: number; maxDepth: number; timeoutMs: number };
    sourcesAdded: number;
    findingsAdded: number;
    notes: string[];
  };
  errors: string[];
  blockedRequests: string[];
  screenshots: string[];
}

interface FrontierItem {
  url: string;
  depth: number;
  discoveredFrom: string | null;
}

const MAX_TEXT_CHARS = 400_000;

export async function researchWebsite(
  config: OpreConfig,
  paths: ProjectPaths,
  manifest: ProjectManifest,
  options: CrawlOptions,
  progress: ResearchProgress,
): Promise<CrawlOutcome> {
  const startedAt = nowIso();
  const targetUrl = parseUrl(manifest.target, {
    scope: 'external',
    allowPrivateNetwork: config.network.allowPrivateNetwork,
    allowedHosts: manifest.config.allowedHosts,
  });
  const allowedHosts = [targetUrl.hostname, ...manifest.config.allowedHosts];
  const loopbackOnly = isLoopbackHost(targetUrl.hostname);

  const { browser, launchOptions } = await launchBrowser(config);
  await progress.report(`Browser launched (${String(launchOptions.label)})`, 0, options.maxPages);

  const pages: PageRecord[] = [];
  const sources: SourceRecord[] = [];
  const findings: FindingRecord[] = [];
  const errors: string[] = [];
  const blockedRequests: string[] = [];
  const screenshots: string[] = [];
  const visited = new Set<string>();
  const frontier: FrontierItem[] = [
    { url: targetUrl.toString(), depth: 0, discoveredFrom: null },
    ...options.extraPaths.map((path) => ({
      url: new URL(path, targetUrl).toString(),
      depth: 0,
      discoveredFrom: null,
    })),
  ];

  if (options.includeScreenshots) {
    await mkdir(paths.screenshots, { recursive: true });
  }

  const context = await createContext(browser, {
    userAgent: config.research.userAgent,
    viewport: options.viewport,
    offline: false,
    ignoreHttpsErrors: false,
    recordHar: options.recordHar
      ? resolveInside(paths.root, 'artifacts/reports/research.har')
      : null,
  });

  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (isDataOrBlob(requestUrl)) {
      await route.continue().catch(() => undefined);
      return;
    }
    try {
      const parsed = parseUrl(requestUrl, {
        scope: 'external',
        allowPrivateNetwork: config.network.allowPrivateNetwork,
        allowedHosts,
      });
      const allowed = loopbackOnly
        ? isLoopbackHost(parsed.hostname)
        : hostMatches(parsed, allowedHosts);
      if (!allowed) {
        recordBlocked(blockedRequests, `${requestUrl} (host not allowed)`);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue();
    } catch {
      recordBlocked(blockedRequests, `${requestUrl} (blocked by policy)`);
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });

  try {
    let maxDepthReached = 0;
    // Pages are inspected concurrently but recorded in frontier order, so runs
    // stay deterministic and reproducible for the same target and limits.
    while (frontier.length > 0 && pages.length < options.maxPages) {
      const batch: FrontierItem[] = [];
      while (frontier.length > 0 && batch.length < options.concurrency) {
        const item = frontier.shift();
        if (item === undefined) {
          break;
        }
        if (visited.has(item.url) || item.depth > options.maxDepth) {
          continue;
        }
        visited.add(item.url);
        batch.push(item);
      }
      if (batch.length === 0) {
        break;
      }
      maxDepthReached = Math.max(maxDepthReached, ...batch.map((item) => item.depth));

      await progress.report(
        `Inspecting ${batch.length} page(s): ${batch.map((item) => item.url).join(', ')}`,
        pages.length,
        options.maxPages,
      );

      const settled = await Promise.all(
        batch.map(async (item) => {
          try {
            return await inspectPage(context, item, options, config, paths);
          } catch (error) {
            return {
              failure: `${item.url}: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }),
      );

      for (const [index, outcome] of settled.entries()) {
        const item = batch[index]!;
        if ('failure' in outcome) {
          errors.push(outcome.failure);
          continue;
        }
        const result = outcome;
        pages.push(result.page);
        sources.push(result.source);
        findings.push(...result.findings);
        screenshots.push(...result.screenshots);
        blockedRequests.push(...result.blockedRequests);
        if (result.error !== null) {
          errors.push(`${item.url}: ${result.error}`);
        }
        for (const link of result.discovered) {
          frontier.push({ url: link.url, depth: item.depth + 1, discoveredFrom: item.url });
        }
      }
    }

    findings.push(buildSurfaceFinding(pages, targetUrl.toString()));

    return {
      pages,
      sources,
      findings,
      run: {
        id: shortId('run'),
        startedAt,
        finishedAt: nowIso(),
        target: manifest.target,
        pagesVisited: pages.length,
        maxDepthReached,
        limits: {
          maxPages: options.maxPages,
          maxDepth: options.maxDepth,
          timeoutMs: options.timeoutMs,
        },
        sourcesAdded: sources.length,
        findingsAdded: findings.length,
        notes: options.notes,
      },
      errors,
      blockedRequests: dedupe(blockedRequests).slice(0, 50),
      screenshots: dedupe(screenshots),
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

interface InspectResult {
  page: PageRecord;
  source: SourceRecord;
  findings: FindingRecord[];
  discovered: Array<{ url: string }>;
  blockedRequests: string[];
  screenshots: string[];
  error: string | null;
}

async function inspectPage(
  context: Awaited<ReturnType<typeof createContext>>,
  item: FrontierItem,
  options: CrawlOptions,
  config: OpreConfig,
  paths: ProjectPaths,
): Promise<InspectResult> {
  const page = await context.newPage();
  await installTransformShim(page);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const blocked: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(clip(message.text(), 300));
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    failedRequests.push(clip(`${request.url()} — ${failure?.errorText ?? 'failed'}`, 300));
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failedRequests.push(clip(`${response.url()} — HTTP ${response.status()}`, 300));
    }
  });

  let error: string | null = null;
  let analysis: PageAnalysis | null = null;
  try {
    const response = await page.goto(item.url, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(5_000, options.timeoutMs) })
      .catch(() => undefined);
    analysis = await extractPageAnalysis(page, options.maxLinksPerPage);
    analysis.httpStatus = response?.status() ?? null;
    analysis.contentType = response?.headers()['content-type'] ?? null;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    analysis =
      analysis ??
      (await extractPageAnalysis(page, options.maxLinksPerPage).catch(() => emptyAnalysis()));
  }

  const pageId = shortId('pg');
  const screenshots: string[] = [];
  const pageErrors: string[] = [];
  if (options.includeScreenshots && error === null) {
    const fileName = `${pageId}-${options.viewport.width}x${options.viewport.height}.png`;
    try {
      await page.screenshot({ path: join(paths.screenshots, fileName), fullPage: false });
      screenshots.push(fileName);
    } catch (caught) {
      pageErrors.push(
        `screenshot failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  const bodyText = analysis.bodyText.slice(0, MAX_TEXT_CHARS);
  const signals = scanForInjection(bodyText, 5);
  const redactions = findSecrets(bodyText);

  // Structural signature, accessibility tree and the page's own CSS: the three
  // artifacts a rebuild needs instead of guessing from a screenshot.
  let fingerprint: FingerprintRecord | null = null;
  let reference: { ariaSnapshotPath: string | null; stylePack: PageRecord['stylePack'] } = {
    ariaSnapshotPath: null,
    stylePack: null,
  };
  if (error === null) {
    try {
      fingerprint = await captureFingerprint(page);
    } catch (caught) {
      pageErrors.push(
        `fingerprint capture failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    try {
      const captured = await captureStyleAndAria(page, paths, pageId);
      reference = { ariaSnapshotPath: captured.ariaPath, stylePack: captured.stylePack };
    } catch (caught) {
      pageErrors.push(
        `style/aria capture failed: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  const record: PageRecord = {
    ...newPageRecord({
      url: item.url,
      finalUrl: page.url(),
      title: analysis.title,
      depth: item.depth,
      discoveredFrom: item.discoveredFrom,
      httpStatus: analysis.httpStatus,
      contentType: analysis.contentType,
      headings: analysis.headings,
      meta: analysis.meta,
      links: analysis.links,
      forms: analysis.forms,
      interactive: analysis.interactive,
      assets: analysis.assets,
      technologies: analysis.technologies,
      screenshotPath: screenshots[0] ?? null,
      viewportsCaptured:
        screenshots.length > 0 ? [`${options.viewport.width}x${options.viewport.height}`] : [],
      consoleErrors: dedupe(consoleErrors).slice(0, 10),
      failedRequests: dedupe(failedRequests).slice(0, 10),
      injectedInstructionSignals: signals.length,
      fingerprint,
      ariaSnapshotPath: reference.ariaSnapshotPath,
      stylePack: reference.stylePack,
      assetPack: null,
      notes: error === null ? pageErrors.join('; ') : `Navigation failed: ${error}`,
    }),
    id: pageId,
  };

  await page.close().catch(() => undefined);

  const source: SourceRecord = newSourceRecord({
    type: 'page',
    uri: record.finalUrl,
    title: record.title === '' ? record.finalUrl : record.title,
    trust: 'untrusted',
    notes: `Observed with an automated browser; ${new Date().toISOString()}`,
  });

  const findings = buildPageFindings(record, source, signals, redactions);

  const discovered = analysis.links
    .filter((link) => link.internal)
    .slice(0, options.maxLinksPerPage)
    .map((link) => ({ url: link.href }));

  const localBlocked: string[] = [...blocked];
  return {
    page: record,
    source,
    findings,
    discovered,
    blockedRequests: localBlocked,
    screenshots,
    error: error === null ? (pageErrors[0] ?? null) : error,
  };
}

interface PageAnalysis {
  title: string;
  meta: Record<string, string>;
  headings: string[];
  links: Array<{ href: string; text: string; internal: boolean }>;
  forms: PageRecord['forms'];
  interactive: PageRecord['interactive'];
  assets: PageRecord['assets'];
  technologies: string[];
  bodyText: string;
  httpStatus: number | null;
  contentType: string | null;
}

async function extractPageAnalysis(page: Page, maxLinks: number): Promise<PageAnalysis> {
  const raw = await page.evaluate((limit: number) => {
    const text = (node: Element | null): string =>
      (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const absolute = (value: string): string => {
      try {
        return new URL(value, document.baseURI).toString();
      } catch {
        return '';
      }
    };

    const meta: Record<string, string> = {};
    for (const element of Array.from(document.querySelectorAll('meta'))) {
      const key = element.getAttribute('name') ?? element.getAttribute('property');
      const value = element.getAttribute('content');
      if (key !== null && value !== null && key.length < 60) {
        meta[key] = value.slice(0, 300);
      }
    }

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((node) => text(node))
      .filter((value) => value.length > 0)
      .slice(0, 25);

    const links: Array<{ href: string; text: string; internal: boolean }> = [];
    const seen = new Set<string>();
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = absolute(anchor.getAttribute('href') ?? '');
      if (href === '' || href.startsWith('javascript:') || href.startsWith('#') || seen.has(href)) {
        continue;
      }
      seen.add(href);
      let internal = false;
      try {
        internal = new URL(href).origin === window.location.origin;
      } catch {
        internal = false;
      }
      links.push({ href, text: text(anchor).slice(0, 120), internal });
      if (links.length >= limit) {
        break;
      }
    }

    const forms = Array.from(document.querySelectorAll('form'))
      .slice(0, 20)
      .map((form, index) => ({
        selector: form.id !== '' ? `#${form.id}` : `form:nth-of-type(${index + 1})`,
        action: form.getAttribute('action') ?? '',
        method: (form.getAttribute('method') ?? 'get').toLowerCase(),
        fields: Array.from(form.querySelectorAll('input, select, textarea'))
          .slice(0, 40)
          .map((field) => {
            const labelNode =
              field.id !== '' ? document.querySelector(`label[for="${field.id}"]`) : null;
            const options = Array.from(field.querySelectorAll('option'))
              .map((option) => option.textContent ?? '')
              .filter((value) => value.length > 0)
              .slice(0, 20);
            return {
              name: field.getAttribute('name') ?? field.getAttribute('id') ?? '',
              type: field.getAttribute('type') ?? field.tagName.toLowerCase(),
              label: (text(labelNode) || field.getAttribute('placeholder') || '').slice(0, 120),
              required: field.hasAttribute('required'),
              options,
            };
          }),
      }));

    const interactive = Array.from(
      document.querySelectorAll(
        'button, [role="button"], input[type="submit"], input[type="button"], select, textarea',
      ),
    )
      .slice(0, 40)
      .map((node, index) => ({
        selector:
          node.id !== ''
            ? `#${node.id}`
            : `${node.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
        role: node.getAttribute('role') ?? node.tagName.toLowerCase(),
        label: (
          text(node) ||
          node.getAttribute('aria-label') ||
          node.getAttribute('name') ||
          ''
        ).slice(0, 120),
        href: node instanceof HTMLAnchorElement ? node.href : null,
      }));

    const assets = Array.from(
      document.querySelectorAll('img[src], script[src], link[rel="stylesheet"][href]'),
    )
      .slice(0, 30)
      .map((node) => {
        const src = node.getAttribute('src') ?? node.getAttribute('href') ?? '';
        const type =
          node.tagName.toLowerCase() === 'img'
            ? 'image'
            : node.tagName.toLowerCase() === 'script'
              ? 'script'
              : 'stylesheet';
        return { url: absolute(src).slice(0, 400), type, bytes: null };
      })
      .filter((asset) => asset.url !== '');

    const technologySignals: string[] = [];
    const generator = meta['generator'] ?? '';
    if (generator !== '') {
      technologySignals.push(`generator: ${generator}`);
    }
    const globals = window as unknown as Record<string, unknown>;
    for (const marker of [
      '__NEXT_DATA__',
      '__NUXT__',
      '__remixContext',
      'webpackChunk_N_E',
      '__sveltekit',
      'Vue',
    ]) {
      if (globals[marker] !== undefined) {
        technologySignals.push(`window.${marker}`);
      }
    }
    if (document.querySelector('[data-reactroot], #root, #app') !== null) {
      technologySignals.push('react-style root node');
    }
    if (
      document.querySelector(
        'script[src*="wp-content"], meta[name="generator"][content*="WordPress" i]',
      ) !== null
    ) {
      technologySignals.push('WordPress');
    }

    return {
      title: document.title.slice(0, 200),
      meta,
      headings,
      links,
      forms,
      interactive,
      assets,
      technologies: technologySignals,
      bodyText: (document.body?.innerText ?? '').slice(0, 200_000),
      htmlLength: document.documentElement.outerHTML.length,
      lang: document.documentElement.lang,
    };
  }, maxLinks);

  return {
    title: raw.title,
    meta: raw.meta,
    headings: raw.headings,
    links: raw.links,
    forms: raw.forms,
    interactive: raw.interactive,
    assets: raw.assets,
    technologies: raw.technologies,
    bodyText: raw.bodyText,
    httpStatus: null,
    contentType: null,
  };
}

function emptyAnalysis(): PageAnalysis {
  return {
    title: '',
    meta: {},
    headings: [],
    links: [],
    forms: [],
    interactive: [],
    assets: [],
    technologies: [],
    bodyText: '',
    httpStatus: null,
    contentType: null,
  };
}

function buildPageFindings(
  record: PageRecord,
  source: SourceRecord,
  signals: ReturnType<typeof scanForInjection>,
  secretSignals: string[],
): FindingRecord[] {
  const findings: FindingRecord[] = [];
  const stamp = nowIso();
  const base = {
    confidence: 'high' as const,
    verification: 'verified' as const,
    featureId: null,
    collectedAt: stamp,
    updatedAt: stamp,
  };

  findings.push({
    id: shortId('fnd'),
    kind: 'observed',
    statement: `Page ${record.url} exposes ${record.links.length} links, ${record.forms.length} form(s) and ${record.interactive.length} interactive element(s).`,
    sourceIds: [source.id],
    evidence: [
      {
        id: shortId('ev'),
        sourceId: source.id,
        kind: 'observed',
        observation: `HTTP ${record.httpStatus ?? 'n/a'}; headings: ${record.headings.slice(0, 5).join(' | ') || '(none)'}`,
        data: {
          forms: record.forms.map((form) => ({
            action: form.action,
            method: form.method,
            fields: form.fields.length,
          })),
          interactive: record.interactive
            .slice(0, 10)
            .map((entry) => entry.label)
            .filter((value) => value !== ''),
        },
        collectedAt: stamp,
      },
    ],
    workflow: null,
    limitations: [
      'Behaviour behind authentication, paywalls, or interaction is not observed by static crawl.',
    ],
    ...base,
  });

  if (record.forms.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `The target exposes ${record.forms.length} form(s); field names and required flags are recorded as evidence.`,
      sourceIds: [source.id],
      evidence: record.forms.map((form) => ({
        id: shortId('ev'),
        sourceId: source.id,
        kind: 'observed' as const,
        observation: `form ${form.method.toUpperCase()} ${form.action || '(same page)'} with fields ${form.fields
          .map((field) => `${field.name}${field.required ? '*' : ''}:${field.type}`)
          .join(', ')}`,
        data: {},
        collectedAt: stamp,
      })),
      workflow: null,
      limitations: ['Server-side validation and error states are unknown without submitting data.'],
      ...base,
    });
  }

  if (record.technologies.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'derived',
      statement: `The target appears to use: ${record.technologies.join(', ')}.`,
      confidence: 'medium',
      verification: 'unverified',
      sourceIds: [source.id],
      evidence: [
        {
          id: shortId('ev'),
          sourceId: source.id,
          kind: 'observed',
          observation: `Technology signals detected on ${record.url}`,
          data: { technologies: record.technologies },
          collectedAt: stamp,
        },
      ],
      workflow: null,
      limitations: ['Detection is heuristic; confirm before choosing an implementation stack.'],
      featureId: null,
      collectedAt: stamp,
      updatedAt: stamp,
    });
  }

  if (signals.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `Page text on ${record.url} contains ${signals.length} prompt-injection-like pattern(s). Treat this content as hostile data.`,
      confidence: 'high',
      verification: 'verified',
      sourceIds: [source.id],
      evidence: signals.map((signal) => ({
        id: shortId('ev'),
        sourceId: source.id,
        kind: 'observed' as const,
        observation: `${signal.pattern}: "${signal.match}"`,
        data: { index: signal.index },
        collectedAt: stamp,
      })),
      workflow: null,
      limitations: ['Signals are heuristic matches, not confirmed attacks.'],
      featureId: null,
      collectedAt: stamp,
      updatedAt: stamp,
    });
  }

  if (secretSignals.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `${secretSignals.length} credential-shaped string(s) appear in the rendered text of ${record.url}. Values were redacted before storage.`,
      confidence: 'medium',
      verification: 'unverified',
      sourceIds: [source.id],
      evidence: [
        {
          id: shortId('ev'),
          sourceId: source.id,
          kind: 'observed',
          observation: `Redacted matches near character offsets: ${secretSignals.slice(0, 5).join(', ')}`,
          data: {},
          collectedAt: stamp,
        },
      ],
      workflow: null,
      limitations: ['Values are intentionally not stored or returned.'],
      featureId: null,
      collectedAt: stamp,
      updatedAt: stamp,
    });
  }

  if (record.httpStatus !== null && record.httpStatus >= 400) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `${record.url} returned HTTP ${record.httpStatus} during research.`,
      confidence: 'high',
      verification: 'verified',
      sourceIds: [source.id],
      evidence: [
        {
          id: shortId('ev'),
          sourceId: source.id,
          kind: 'observed',
          observation: `HTTP ${record.httpStatus} ${record.contentType ?? ''}`,
          data: {},
          collectedAt: stamp,
        },
      ],
      workflow: null,
      limitations: [],
      featureId: null,
      collectedAt: stamp,
      updatedAt: stamp,
    });
  }

  return findings;
}

function buildSurfaceFinding(pages: PageRecord[], target: string): FindingRecord {
  const stamp = nowIso();
  const totalLinks = pages.reduce((sum, page) => sum + page.links.length, 0);
  const totalForms = pages.reduce((sum, page) => sum + page.forms.length, 0);
  const routes = pages.map((page) => page.url);
  return {
    id: shortId('fnd'),
    kind: 'derived',
    statement: `Crawl of ${target} visited ${pages.length} page(s) at depth ≤ ${Math.max(...pages.map((page) => page.depth), 0)}, covering ${totalLinks} links and ${totalForms} form(s).`,
    confidence: 'medium',
    verification: 'unverified',
    sourceIds: pages.length > 0 ? ['aggregate'] : [],
    evidence: [
      {
        id: shortId('ev'),
        sourceId: 'aggregate',
        kind: 'derived',
        observation: `Visited routes:\n${routes.map((url) => `- ${url}`).join('\n')}`,
        data: { pages: pages.length },
        collectedAt: stamp,
      },
    ],
    workflow: null,
    limitations: [
      'The crawl is bounded by OPRE_RESEARCH_MAX_PAGES / OPRE_RESEARCH_MAX_DEPTH; deeper areas are unobserved.',
      'Authenticated and dynamic routes are not covered.',
    ],
    featureId: null,
    collectedAt: stamp,
    updatedAt: stamp,
  };
}

function findSecrets(text: string): string[] {
  const offsets: string[] = [];
  const pattern = /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi;
  let match = pattern.exec(text);
  while (match !== null && offsets.length < 5) {
    offsets.push(String(match.index));
    match = pattern.exec(text);
  }
  return offsets;
}

function recordBlocked(sink: string[], entry: string): void {
  if (sink.length < 100) {
    sink.push(entry);
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function clip(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function isDataOrBlob(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:');
}

export function assertCrawlFeasible(config: OpreConfig): void {
  if (config.research.maxPages < 1) {
    throw new ResearchError('Research limits must allow at least one page.');
  }
}
