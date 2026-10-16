/**
 * Asset localisation — the difference between "evidence about a site" and "a copy
 * you can build against".
 *
 * Every serious mirroring/cloning tool downloads the real images, fonts,
 * stylesheets and media rather than describing them. So does OPRE:
 *
 *  - candidates are collected from `src`, `srcset`, `poster`, lazy attributes and
 *    computed `background-image` (after a scroll pass for lazy content);
 *  - they are fetched through the browser's request context, so cookies, headers
 *    and redirects behave exactly as they did for the page — and no extra page
 *    navigation is needed, which is what makes capture fast;
 *  - every URL goes through the same allowlist/SSRF policy as the crawler;
 *  - downloads are deduped by URL across routes and written under
 *    `artifacts/assets/`, with a `URL -> local file` manifest.
 *
 * Stylesheet text is captured at the same time (see `styles.ts`).
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { redactSecrets } from '../security/untrusted.js';

export type AssetKind = 'image' | 'font' | 'stylesheet' | 'media' | 'icon' | 'other';

export interface AssetRecord {
  url: string;
  /** Project-relative path, or null when the download failed or was skipped. */
  localPath: string | null;
  kind: AssetKind;
  contentType: string | null;
  bytes: number;
  status: 'ok' | 'skipped' | 'failed';
  note: string;
  /** Set when the same URL was already downloaded for another route. */
  deduped: boolean;
  /** Alt text of the <img> that referenced it, so the rebuild keeps the a11y tree. */
  alt: string | null;
}

export interface AssetCaptureOptions {
  maxAssets: number;
  maxBytes: number;
  concurrency: number;
  timeoutMs: number;
  kinds: AssetKind[];
  /** Predicate that decides whether a URL may be fetched (SSRF + allowlist). */
  allowUrl: (url: string) => boolean;
  /** Called for every URL we refuse, with the reason. */
  onBlocked?: (url: string, reason: string) => void;
  scrollForLazyAssets: boolean;
  scrollHeightPx: number;
}

export const DEFAULT_ASSET_OPTIONS: Omit<AssetCaptureOptions, 'allowUrl'> = {
  maxAssets: 60,
  maxBytes: 25_000_000,
  concurrency: 6,
  timeoutMs: 15_000,
  kinds: ['image', 'font', 'stylesheet', 'media', 'icon'],
  scrollForLazyAssets: true,
  scrollHeightPx: 6000,
};

export interface RouteAssets {
  assets: AssetRecord[];
  /** Stylesheet URLs that were read, in document order. */
  stylesheets: string[];
  totalBytes: number;
  skipped: number;
  failed: number;
}

/** Reads the asset candidates a rendered page actually uses. */
export async function collectAssetCandidates(
  page: Page,
  options: { scrollForLazyAssets: boolean; scrollHeightPx: number },
): Promise<Array<{ url: string; kind: AssetKind; alt: string | null }>> {
  if (options.scrollForLazyAssets) {
    // Lazy images only exist in the DOM once they are scrolled into view.
    await page
      .evaluate(async (limit: number) => {
        const step = Math.max(300, Math.floor(window.innerHeight * 0.9));
        for (let y = 0; y < limit; y += step) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        window.scrollTo(0, 0);
      }, options.scrollHeightPx)
      .catch(() => undefined);
  }

  return page.evaluate(() => {
    const absolute = (value: string): string => {
      // An empty attribute (a missing data-src, an empty srcset entry) must not
      // resolve against document.baseURI: that yields the page's own URL, which
      // would then be downloaded as an "asset".
      const raw = String(value ?? '').trim();
      if (raw === '') {
        return '';
      }
      try {
        return new URL(raw, document.baseURI).toString();
      } catch {
        return '';
      }
    };
    const found = new Map<string, { kind: AssetKind; alt: string | null }>();

    const add = (value: string, kind: AssetKind, alt: string | null = null): void => {
      const url = absolute(value);
      if (url === '' || found.has(url)) {
        return;
      }
      found.set(url, { kind, alt: alt === '' ? null : alt });
    };

    for (const image of Array.from(document.querySelectorAll('img'))) {
      const alt = (image.getAttribute('alt') ?? '').trim().slice(0, 120);
      add(image.getAttribute('src') ?? '', 'image', alt);
      add(image.getAttribute('data-src') ?? '', 'image', alt);
      const srcset = image.getAttribute('srcset') ?? image.getAttribute('data-srcset') ?? '';
      for (const candidate of srcset.split(',')) {
        add(candidate.trim().split(/\s+/)[0] ?? '', 'image', alt);
      }
    }
    for (const source of Array.from(document.querySelectorAll('source'))) {
      const srcset = source.getAttribute('srcset') ?? '';
      for (const candidate of srcset.split(',')) {
        add(candidate.trim().split(/\s+/)[0] ?? '', 'image');
      }
    }
    for (const video of Array.from(document.querySelectorAll('video'))) {
      add(video.getAttribute('poster') ?? '', 'media');
      add(video.getAttribute('src') ?? '', 'media');
    }
    for (const link of Array.from(document.querySelectorAll('link[href]'))) {
      const rel = (link.getAttribute('rel') ?? '').toLowerCase();
      if (rel.includes('stylesheet')) {
        add(link.getAttribute('href') ?? '', 'stylesheet');
      } else if (rel.includes('icon')) {
        add(link.getAttribute('href') ?? '', 'icon');
      } else if (rel.includes('preload') && (link.getAttribute('as') ?? '') === 'font') {
        add(link.getAttribute('href') ?? '', 'font');
      }
    }
    for (const element of Array.from(document.querySelectorAll('[style*="background"]'))) {
      const style = element.getAttribute('style') ?? '';
      for (const match of style.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
        add(match[2] ?? '', 'image');
      }
    }
    // Computed backgrounds catch stylesheet-driven hero images.
    for (const element of Array.from(document.querySelectorAll('body *')).slice(0, 500)) {
      const background = window.getComputedStyle(element).backgroundImage;
      if (background === 'none' || background === '') {
        continue;
      }
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        add(match[1] ?? '', 'image');
      }
    }
    return [...found.entries()].map(([url, entry]) => ({ url, kind: entry.kind, alt: entry.alt }));
  });
}

/**
 * Downloads the candidates for one route into `assetsDir`, reusing any file that
 * was already downloaded for another route.
 */
export async function captureRouteAssets(
  context: BrowserContext,
  page: Page,
  route: string,
  assetsDir: string,
  options: AssetCaptureOptions,
  dedupe: Map<string, AssetRecord>,
): Promise<RouteAssets> {
  await mkdir(assetsDir, { recursive: true });

  const candidates = await collectAssetCandidates(page, {
    scrollForLazyAssets: options.scrollForLazyAssets,
    scrollHeightPx: options.scrollHeightPx,
  });

  const usable = candidates
    .filter((candidate) => options.kinds.includes(candidate.kind))
    .filter((candidate) => !candidate.url.startsWith('data:'))
    .slice(0, options.maxAssets);

  const records: AssetRecord[] = [];
  const stylesheets: string[] = [];
  let skipped = 0;
  let failed = 0;

  // Bounded parallelism: fast on a normal page, gentle on the target. The byte
  // budget is shared state, not a captured value, so concurrent workers cannot
  // each spend the whole allowance.
  const budget = { bytes: 0, exhausted: false };
  const queue = [...usable];
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (candidate === undefined) {
        return;
      }
      const outcome = await downloadAsset(
        context,
        candidate,
        route,
        assetsDir,
        options,
        dedupe,
        budget,
      );
      if (outcome.status === 'skipped') {
        skipped += 1;
      }
      if (outcome.status === 'failed') {
        failed += 1;
      }
      if (outcome.status === 'ok') {
        if (outcome.kind === 'stylesheet') {
          stylesheets.push(outcome.url);
        }
      }
      records.push(outcome);
    }
  });
  await Promise.all(workers);

  return { assets: records, stylesheets, totalBytes: budget.bytes, skipped, failed };
}

async function downloadAsset(
  context: BrowserContext,
  candidate: { url: string; kind: AssetKind; alt: string | null },
  route: string,
  assetsDir: string,
  options: AssetCaptureOptions,
  dedupe: Map<string, AssetRecord>,
  budget: { bytes: number; exhausted: boolean },
): Promise<AssetRecord> {
  const base: AssetRecord = {
    url: candidate.url,
    localPath: null,
    kind: candidate.kind,
    contentType: null,
    bytes: 0,
    status: 'skipped',
    note: '',
    deduped: false,
    alt: candidate.alt,
  };

  if (dedupe.has(candidate.url)) {
    const existing = dedupe.get(candidate.url)!;
    return {
      ...existing,
      deduped: true,
      alt: candidate.alt ?? existing.alt,
      note: existing.note || 'reused from an earlier route',
    };
  }

  if (!options.allowUrl(candidate.url)) {
    const reason = 'blocked by the network policy (not on the allowlist, or a private address)';
    options.onBlocked?.(candidate.url, reason);
    const record = { ...base, note: reason };
    dedupe.set(candidate.url, record);
    return record;
  }

  if (budget.exhausted) {
    const record = { ...base, note: 'skipped: the per-run asset byte budget is exhausted' };
    dedupe.set(candidate.url, record);
    return record;
  }

  try {
    const response = await context.request.get(candidate.url, { timeout: options.timeoutMs });
    if (!response.ok()) {
      const record = { ...base, status: 'failed' as const, note: `HTTP ${response.status()}` };
      dedupe.set(candidate.url, record);
      return record;
    }
    const contentType = response.headers()['content-type'] ?? null;
    const body = await response.body();
    if (body.byteLength > options.maxBytes) {
      const record = { ...base, status: 'failed' as const, note: 'larger than the byte budget' };
      dedupe.set(candidate.url, record);
      return record;
    }

    const extension = extensionFor(candidate.url, contentType);
    const fileName = `${createHash('sha1').update(candidate.url).digest('hex').slice(0, 16)}${extension}`;
    const absolute = join(assetsDir, fileName);
    // Never persist raw responses unfiltered: strip credential-shaped strings
    // from textual assets before they land on disk.
    const isTextual = (contentType ?? '').match(/text|css|javascript|json|svg/);
    const payload =
      isTextual === null ? body : Buffer.from(redactSecrets(body.toString('utf8')).text, 'utf8');
    await writeFile(absolute, payload);

    const record: AssetRecord = {
      url: candidate.url,
      localPath: `${route}/${fileName}`,
      kind: candidate.kind,
      contentType,
      bytes: payload.byteLength,
      status: 'ok',
      note: '',
      deduped: false,
      alt: candidate.alt,
    };
    budget.bytes += payload.byteLength;
    dedupe.set(candidate.url, record);
    return record;
  } catch (error) {
    const record = {
      ...base,
      status: 'failed' as const,
      note:
        error instanceof Error ? error.message.split('\n')[0]!.slice(0, 120) : 'download failed',
    };
    dedupe.set(candidate.url, record);
    return record;
  }
}

function extensionFor(url: string, contentType: string | null): string {
  const fromPath = extname(new URL(url).pathname);
  if (fromPath !== '' && fromPath.length <= 6) {
    return fromPath;
  }
  const fromType = (contentType ?? '').split(';')[0]?.trim();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'image/x-icon': '.ico',
    'font/woff2': '.woff2',
    'font/woff': '.woff',
    'font/ttf': '.ttf',
    'text/css': '.css',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };
  return fromType === undefined ? '' : (map[fromType] ?? '');
}

/**
 * Rewrites `url(...)` references in CSS to the localised files.
 * `baseUrl` is the URL the stylesheet was served from, so relative references
 * resolve exactly the way the browser resolved them.
 */
export function rewriteCssUrls(
  css: string,
  urlToLocalPath: Map<string, string>,
  baseUrl: string,
  toRouteDir: string,
): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote: string, rawUrl: string) => {
    const absolute = safeAbsolute(rawUrl, baseUrl);
    const local = urlToLocalPath.get(absolute);
    if (local === undefined) {
      return match;
    }
    const relative = relativePath(toRouteDir, local);
    return `url("${relative}")`;
  });
}

function safeAbsolute(value: string, baseUrl: string): string {
  if (value.startsWith('data:')) {
    return value;
  }
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function relativePath(from: string, to: string): string {
  const fromParts = from.split('/').filter((part) => part !== '');
  const toParts = to.split('/').filter((part) => part !== '');
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }
  const up = fromParts.length - shared;
  return `${'../'.repeat(up)}${toParts.slice(shared).join('/')}`;
}
