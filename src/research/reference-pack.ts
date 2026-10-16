/**
 * Reference packs: the evidence a rebuild needs, handed to the agent in one call.
 *
 * Screenshot-to-code tools feed an agent a picture and let it guess. OPRE hands it
 * the real things: the reference screenshots, an accessibility tree (cheap, and
 * resilient to layout reflow), the target's own CSS, a computed-style map, the
 * localised asset manifest, and the structural fingerprint to match.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { toProjectRelative } from '../knowledge/store.js';
import type { ProjectPaths } from '../project/paths.js';
import { resolveInside } from '../security/paths.js';
import { writeFileAtomic } from '../core/json-store.js';
import {
  captureRouteAssets,
  DEFAULT_ASSET_OPTIONS,
  rewriteCssUrls,
  type AssetCaptureOptions,
  type AssetKind,
  type AssetRecord,
} from './assets.js';
import { computedStylesToCss, extractComputedStyleMap, extractStyleSheets } from './styles.js';
import type { PageRecord } from './types.js';
import type { OpreConfig } from '../config.js';
import { parseUrl } from '../security/url.js';
import { hostMatches, normalizeHost } from '../security/url.js';

export interface ReferencePack {
  project: string;
  target: string;
  /** Absolute local paths, so an agent can open them directly. */
  referenceScreenshot: string | null;
  routes: Array<{
    route: string;
    url: string;
    screenshot: string | null;
    aria: string | null;
    css: string | null;
    computedCss: string | null;
    assets: string | null;
    headings: string[];
    textBlockCount: number;
    forms: number;
    interactive: number;
    landmarks: string[];
    tokens: { colors: number; fontFamilies: number; fontSizes: number };
  }>;
  totals: {
    routes: number;
    screenshots: number;
    stylesheets: number;
    assets: number;
    assetBytes: number;
  };
  instructions: string[];
}

export interface RouteAssetSummary {
  route: string;
  manifestPath: string;
  /** Rewritten stylesheet with url(...) pointing at the localised assets. */
  cssPath: string | null;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  bytes: number;
}

export interface AssetCaptureResult {
  routes: number;
  routeManifests: RouteAssetSummary[];
  assets: number;
  ok: number;
  failed: number;
  skipped: number;
  deduped: number;
  bytes: number;
  manifests: string[];
  blocked: Array<{ url: string; reason: string }>;
  stylesheetsRewritten: number;
  notes: string[];
}

/** Downloads images, fonts and media for every researched route. */
export async function captureAssetsForProject(
  config: OpreConfig,
  paths: ProjectPaths,
  pages: PageRecord[],
  options: {
    maxAssetsPerRoute?: number;
    maxBytes?: number;
    kinds?: AssetKind[];
    /** Extra hosts from project.manifest.config.allowedHosts. */
    allowedHosts?: string[];
  } = {},
): Promise<AssetCaptureResult> {
  const { launchBrowser, installTransformShim } = await import('./browser.js');
  const { browser } = await launchBrowser(config);
  const target = pages[0];
  if (target === undefined) {
    await browser.close();
    return {
      routes: 0,
      routeManifests: [],
      assets: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      deduped: 0,
      bytes: 0,
      manifests: [],
      blocked: [],
      stylesheetsRewritten: 0,
      notes: ['No researched pages to capture assets from. Run opre.start_research first.'],
    };
  }

  // Assets live on the target host plus whatever the operator explicitly allowed
  // on the project. Hard-coding only the target host silently dropped third-party
  // stylesheets (CDN Bootstrap, Font Awesome, image hosts), which left the rebuilt
  // page with no layout and no icons.
  const allowedHosts = [
    normalizeHost(new URL(target.url).hostname),
    ...(options.allowedHosts ?? []).map((host) => normalizeHost(host)),
  ].filter((host, index, all) => host !== '' && all.indexOf(host) === index);
  const captureOptions: AssetCaptureOptions = {
    ...DEFAULT_ASSET_OPTIONS,
    ...(options.maxAssetsPerRoute === undefined ? {} : { maxAssets: options.maxAssetsPerRoute }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    allowUrl: (url: string) => {
      try {
        const parsed = parseUrl(url, {
          scope: 'external',
          allowPrivateNetwork: config.network.allowPrivateNetwork,
          allowedHosts,
        });
        return hostMatches(parsed, allowedHosts);
      } catch {
        return false;
      }
    },
  };

  const context = await browser.newContext({
    userAgent: config.research.userAgent,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await installTransformShim(page);

  const assetsDir = resolveInside(paths.root, 'artifacts/assets');
  await mkdir(assetsDir, { recursive: true });
  const dedupe = new Map<string, AssetRecord>();
  const blocked: Array<{ url: string; reason: string }> = [];
  const manifests: string[] = [];
  const routeManifests: RouteAssetSummary[] = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let deduped = 0;
  let bytes = 0;
  let stylesheetsRewritten = 0;

  try {
    for (const pageRecord of pages.slice(0, 12)) {
      const routeSlug = slug(pageRecord.fingerprint?.route ?? new URL(pageRecord.url).pathname);
      const routeDir = join(assetsDir, routeSlug);
      await page.goto(pageRecord.url, {
        waitUntil: 'domcontentloaded',
        timeout: config.research.timeoutMs,
      });

      const captured = await captureRouteAssets(
        context,
        page,
        routeSlug,
        routeDir,
        {
          ...captureOptions,
          onBlocked: (url, reason) => {
            if (blocked.length < 40) {
              blocked.push({ url, reason });
            }
          },
        },
        dedupe,
      );

      ok += captured.assets.filter((asset) => asset.status === 'ok' && !asset.deduped).length;
      failed += captured.assets.filter((asset) => asset.status === 'failed').length;
      skipped += captured.skipped;
      deduped += captured.assets.filter((asset) => asset.deduped).length;
      bytes += captured.totalBytes;

      // Rewrite the captured stylesheets so their url(...) points at the local files.
      const urlToLocal = new Map<string, string>();
      for (const asset of captured.assets) {
        if (asset.status === 'ok' && asset.localPath !== null) {
          urlToLocal.set(asset.url, `../assets/${asset.localPath}`);
        }
      }
      const stylesDir = resolveInside(paths.root, 'artifacts/styles');
      await mkdir(stylesDir, { recursive: true });
      let rewrittenCssPath: string | null = null;
      if (captured.stylesheets.length > 0) {
        let combined = '';
        for (const href of captured.stylesheets) {
          const record = dedupe.get(href);
          if (record?.localPath === undefined || record.localPath === null) {
            continue;
          }
          const css = await readFile(join(assetsDir, record.localPath), 'utf8').catch(() => '');
          // Resolve each url(...) against the stylesheet's own URL, not against a
          // route directory: a root-relative "/logo.png" is relative to the
          // origin, so the old path-based lookup never matched and the rewrite
          // silently did nothing.
          combined += rewriteCssUrls(css, urlToLocal, href, '/');
          stylesheetsRewritten += 1;
        }
        if (combined !== '') {
          rewrittenCssPath = `artifacts/styles/${routeSlug}.css`;
          await writeFileAtomic(join(stylesDir, `${routeSlug}.css`), combined);
        }
      }

      const manifestPath = join(routeDir, 'manifest.json');
      const manifest = {
        route: pageRecord.fingerprint?.route ?? pageRecord.url,
        sourceUrl: pageRecord.url,
        capturedAt: new Date().toISOString(),
        assets: captured.assets,
      };
      await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const projectRelative = toProjectRelative(paths, manifestPath);
      manifests.push(projectRelative);
      // Without this the page never receives an assetPack, so the reference pack
      // and the scaffold see no assets at all.
      routeManifests.push({
        route: manifest.route,
        manifestPath: projectRelative,
        cssPath: rewrittenCssPath,
        total: captured.assets.length,
        ok: captured.assets.filter((asset) => asset.status === 'ok').length,
        failed: captured.failed,
        skipped: captured.skipped,
        bytes: captured.totalBytes,
      });
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  return {
    routes: Math.min(pages.length, 12),
    routeManifests,
    assets: ok + failed + skipped,
    ok,
    failed,
    skipped,
    deduped,
    bytes,
    manifests,
    blocked,
    stylesheetsRewritten,
    notes: [
      'Assets are stored under artifacts/assets/ and referenced by the manifests above.',
      'A blocked URL was not downloaded: it is either off the allowlist or resolves to a private address.',
    ],
  };
}

/** The single call an agent makes to get everything it needs to reproduce the target. */
export async function buildReferencePack(
  config: OpreConfig,
  paths: ProjectPaths,
  projectName: string,
  target: string,
  pages: PageRecord[],
): Promise<ReferencePack> {
  const routes = [];
  let screenshots = 0;
  let stylesheets = 0;
  let assets = 0;

  for (const page of pages) {
    const ariaPath = page.ariaSnapshotPath;
    const aria =
      ariaPath === null
        ? null
        : await readFile(join(paths.root, ariaPath), 'utf8').catch(() => null);
    const cssPath = page.stylePack?.cssPath ?? null;
    if (cssPath !== null) {
      stylesheets += 1;
    }
    const manifestPath = page.assetPack?.manifestPath ?? null;
    if (manifestPath !== null) {
      const manifest = await readJsonSafe(join(paths.root, manifestPath));
      assets += Array.isArray(manifest?.['assets']) ? (manifest['assets'] as unknown[]).length : 0;
    }
    if (page.screenshotPath !== null) {
      screenshots += 1;
    }
    routes.push({
      route: page.fingerprint?.route ?? new URL(page.url).pathname,
      url: page.url,
      screenshot: page.screenshotPath === null ? null : screenshotOf(paths, page.screenshotPath),
      aria: aria === null ? null : join(paths.root, ariaPath!),
      css: cssPath === null ? null : join(paths.root, cssPath),
      computedCss: page.stylePack?.computedCssPath
        ? join(paths.root, page.stylePack.computedCssPath)
        : null,
      assets: manifestPath === null ? null : join(paths.root, manifestPath),
      headings: (page.fingerprint?.headings ?? []).map(
        (heading) => `h${heading.level}: ${heading.text}`,
      ),
      textBlockCount: page.fingerprint?.textBlocks.length ?? 0,
      forms: page.fingerprint?.forms.length ?? 0,
      interactive: page.fingerprint?.interactive.length ?? 0,
      landmarks: page.fingerprint?.landmarks ?? [],
      tokens: {
        colors: page.fingerprint?.tokens.colors.length ?? 0,
        fontFamilies: page.fingerprint?.tokens.fontFamilies.length ?? 0,
        fontSizes: page.fingerprint?.tokens.fontSizes.length ?? 0,
      },
    });
  }

  return {
    project: projectName,
    target,
    referenceScreenshot: pages[0]?.screenshotPath
      ? join(paths.root, pages[0].screenshotPath)
      : null,
    routes,
    totals: { routes: routes.length, screenshots, stylesheets, assets, assetBytes: 0 },
    instructions: [
      'These are absolute local paths. Open the screenshots and the CSS; do not guess from pixels.',
      'Reproduce the routes, headings, text blocks, forms, controls and landmarks listed here.',
      'Reuse the localised assets under artifacts/assets/ instead of hot-linking the original site.',
      'opre.scaffold_app writes a runnable starting point from this pack; then refine it task by task.',
    ],
  };
}

/** Captures the accessibility tree and the page's real CSS into the project. */
export async function captureStyleAndAria(
  page: Page,
  paths: ProjectPaths,
  pageId: string,
): Promise<{
  ariaPath: string | null;
  stylePack: PageRecord['stylePack'];
}> {
  const stylesDir = resolveInside(paths.root, 'artifacts/styles');
  await mkdir(stylesDir, { recursive: true });

  const bundle = await extractStyleSheets(page).catch(() => null);
  let cssPath: string | null = null;
  let computedCssPath: string | null = null;
  let variables = 0;
  let mediaQueries = 0;
  let keyframes = 0;
  let fontFaces = 0;

  if (bundle !== null) {
    if (bundle.css.trim() !== '') {
      cssPath = `artifacts/styles/${pageId}.css`;
      await writeFileAtomic(join(stylesDir, `${pageId}.css`), bundle.css);
    }
    const computed = await extractComputedStyleMap(page).catch(() => []);
    if (computed.length > 0) {
      computedCssPath = `artifacts/styles/${pageId}.computed.css`;
      await writeFileAtomic(
        join(stylesDir, `${pageId}.computed.css`),
        computedStylesToCss(computed),
      );
    }
    variables = Object.keys(bundle.variables).length;
    mediaQueries = bundle.mediaQueries.length;
    keyframes = bundle.keyframes.length;
    fontFaces = bundle.fontFaces.length;
  }

  const ariaPath = `artifacts/aria/${pageId}.json`;
  const aria = await captureAriaSnapshot(page);
  if (aria === null) {
    return {
      ariaPath: null,
      stylePack:
        cssPath === null && computedCssPath === null
          ? null
          : {
              cssPath,
              computedCssPath,
              variables,
              mediaQueries,
              keyframes,
              fontFaces,
              computedCount: 0,
            },
    };
  }
  const ariaDir = resolveInside(paths.root, 'artifacts/aria');
  await mkdir(ariaDir, { recursive: true });
  await writeFile(join(ariaDir, `${pageId}.json`), `${JSON.stringify(aria, null, 2)}\n`);

  return {
    ariaPath,
    stylePack:
      cssPath === null && computedCssPath === null
        ? null
        : {
            cssPath,
            computedCssPath,
            variables,
            mediaQueries,
            keyframes,
            fontFaces,
            computedCount: 0,
          },
  };
}

/**
 * A compact role/label tree. Far cheaper than a screenshot in tokens and, unlike
 * a screenshot, it survives layout reflow — the reason browser MCPs prefer it.
 */
export async function captureAriaSnapshot(
  page: Page,
): Promise<{ route: string; tree: string } | null> {
  const tree = await page
    .evaluate(() => {
      const lines: string[] = [];
      const walk = (node: Element, depth: number): void => {
        if (depth > 12 || lines.length > 400) {
          return;
        }
        const role =
          node.getAttribute('role') ??
          (node.tagName === 'A' && node.hasAttribute('href')
            ? 'link'
            : node.tagName === 'BUTTON'
              ? 'button'
              : node.tagName.toLowerCase());
        const label = (
          node.getAttribute('aria-label') ??
          node.getAttribute('alt') ??
          node.textContent ??
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        const significant = [
          'a',
          'button',
          'input',
          'select',
          'textarea',
          'h1',
          'h2',
          'h3',
          'nav',
          'main',
          'header',
          'footer',
          'form',
          'img',
        ].includes(role);
        if (significant) {
          lines.push(`${'  '.repeat(depth)}${role}${label === '' ? '' : `: ${label}`}`);
        }
        for (const child of Array.from(node.children).slice(0, 40)) {
          walk(child, depth + 1);
        }
      };
      if (document.body !== null) {
        walk(document.body, 0);
      }
      return lines.join('\n');
    })
    .catch(() => null);
  if (tree === null) {
    return null;
  }
  return { route: `${new URL(page.url()).pathname}`, tree };
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Page records store a bare file name; screenshots live in artifacts/screenshots. */
export function screenshotOf(paths: ProjectPaths, fileName: string): string {
  return join(paths.screenshots, fileName);
}

function slug(route: string): string {
  return (
    route
      .replace(/[^a-zA-Z0-9/_-]/g, '-')
      .replace(/\/+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'root'
  );
}
