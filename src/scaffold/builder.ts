/**
 * Scaffold: turn the reference into a runnable local copy.
 *
 * This is the deterministic half of cloning that every competitor performs —
 * real markup structure, the target's own stylesheet, localised assets, working
 * routes — so the agent starts from something that already renders like the
 * original and refines it, instead of writing a blank page and guessing.
 *
 * It is a *starting point*, not a finished clone: the agent owns layout detail,
 * responsive behaviour, interactivity and semantics, and the fidelity gate
 * (`opre.run_validation`) tells it what is still wrong.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveInside } from '../security/paths.js';
import type { ProjectPaths } from '../project/paths.js';
import type { PageRecord } from '../research/types.js';

export interface ScaffoldOptions {
  linkCss: boolean;
}

export interface ScaffoldOutcome {
  routes: string[];
  files: string[];
  assetsLinked: number;
  stylesheets: number;
  warnings: string[];
}

export async function buildScaffold(
  paths: ProjectPaths,
  appDirRelative: string,
  pages: PageRecord[],
  options: ScaffoldOptions,
): Promise<ScaffoldOutcome> {
  const appDir = resolveInside(paths.root, appDirRelative);
  const assetsOut = join(appDir, 'assets');
  const stylesOut = join(appDir, 'styles');
  await mkdir(appDir, { recursive: true });
  await mkdir(assetsOut, { recursive: true });
  await mkdir(stylesOut, { recursive: true });

  const usable = pages.filter(
    (page) => page.fingerprint !== null && (page.httpStatus === null || page.httpStatus < 400),
  );
  const warnings: string[] = [];
  if (usable.length === 0) {
    warnings.push('No page had a fingerprint; the scaffold is empty. Re-run opre.start_research.');
  }

  let assetsLinked = 0;
  let stylesheets = 0;
  const routeMap: Record<string, string> = {};
  const files: string[] = [];
  const cssByIndex = new Map<number, string>();

  for (const [index, page] of usable.entries()) {
    const route = page.fingerprint?.route ?? new URL(page.url).pathname;
    const fileName = `page-${index}.html`;
    const assetDirName = slug(route);

    // Copy this route's localised assets into app/assets/<route>/ and keep the
    // images so the markup can point at real files instead of empty srcs.
    const manifestPath = page.assetPack?.manifestPath ?? null;
    const manifest = manifestPath === null ? null : await readManifest(paths, manifestPath);
    if (manifestPath !== null && manifest === null) {
      warnings.push(`Asset manifest unreadable for ${route}; assets were not linked.`);
    }
    const images: Array<{ src: string; alt: string }> = [];
    if (manifest !== null) {
      const targetDir = join(assetsOut, assetDirName);
      await mkdir(targetDir, { recursive: true });
      for (const asset of manifest.assets) {
        if (asset.status !== 'ok' || asset.localPath === null) {
          continue;
        }
        const source = resolveInside(paths.root, join('artifacts/assets', asset.localPath));
        const name = asset.localPath.split('/').pop() ?? 'asset';
        const body = await readFile(source).catch(() => null);
        if (body === null) {
          warnings.push(`Asset ${asset.url} could not be copied.`);
          continue;
        }
        await writeFile(join(targetDir, name), body);
        assetsLinked += 1;
        if (asset.kind === 'image') {
          images.push({ src: `assets/${assetDirName}/${name}`, alt: asset.alt ?? '' });
        }
      }
    }

    const assetPack = page.assetPack ?? null;

    // Copy the captured stylesheet next to the page. The asset pass already
    // rewrote url(...) to the localised files, so nothing else is rewritten here.
    // Pages without an external stylesheet (inline <style>, CSS-in-JS) still get
    // the computed-style map as a baseline, otherwise the rebuild renders unstyled.
    let cssFile: string | null = null;
    // Prefer the stylesheet the asset pass rewrote (its url(...) already points
    // at artifacts/assets/<route>/), then the raw research capture, then the
    // computed-style baseline for pages with no external stylesheet.
    const cssCandidates = [
      page.assetPack?.cssPath ?? null,
      page.stylePack?.cssPath ?? null,
      page.stylePack?.computedCssPath ?? null,
    ];
    if (options.linkCss) {
      for (const candidate of cssCandidates) {
        if (candidate === null) {
          continue;
        }
        const css = await readFile(resolveInside(paths.root, candidate), 'utf8').catch(() => null);
        if (css === null || css.trim() === '') {
          continue;
        }
        cssFile = `${fileName}.css`;
        // The rewritten stylesheet points at ../assets/<route>/..., which is
        // exactly how the files were laid out under app/. The raw capture points
        // at the live target, so its url(...) is resolved to the local copies.
        const body = assetPack?.cssPath === candidate ? css : rewriteAssetUrls(css, manifest);
        await writeFile(join(stylesOut, cssFile), body, 'utf8');
        files.push(`styles/${cssFile}`);
        stylesheets += 1;
        cssByIndex.set(index, cssFile);
        break;
      }
    }

    const html = renderRoute(page, route, options, cssFile, images);
    await writeFile(join(appDir, fileName), html, 'utf8');
    files.push(fileName);
    routeMap[route] = fileName;
  }

  if (usable.length > 0) {
    // The root route reuses the same page as `/`, so it must also reuse that
    // page's stylesheet rather than linking a styles/index.css that was never written.
    const rootIndex = usable.findIndex(
      (page) => (page.fingerprint?.route ?? new URL(page.url).pathname) === '/',
    );
    const rootIndex2 = rootIndex === -1 ? 0 : rootIndex;
    const rootPage = usable[rootIndex2]!;
    const rootCss = cssByIndex.get(rootIndex2) ?? null;
    const rootManifestPath = rootPage.assetPack?.manifestPath ?? null;
    const rootManifest =
      rootManifestPath === null ? null : await readManifest(paths, rootManifestPath);
    const rootAssets: Array<{ src: string; alt: string }> = [];
    if (rootManifest !== null) {
      const rootDirName = slug('/');
      for (const asset of rootManifest.assets) {
        if (asset.kind === 'image' && asset.status === 'ok' && asset.localPath !== null) {
          const name = asset.localPath.split('/').pop() ?? 'asset';
          rootAssets.push({ src: `assets/${rootDirName}/${name}`, alt: asset.alt ?? '' });
        }
      }
    }
    const rootHtml = renderRoute(rootPage, '/', options, rootCss, rootAssets);
    await writeFile(join(appDir, 'index.html'), rootHtml, 'utf8');
    files.push('index.html');
  }

  await writeFile(join(appDir, 'routes.json'), `${JSON.stringify(routeMap, null, 2)}\n`, 'utf8');
  await writeFile(join(appDir, 'server.js'), SERVER_SOURCE, 'utf8');
  files.push('routes.json', 'server.js');
  if (options.linkCss) {
    await writeFile(join(appDir, 'copy-styles.css'), CSS_HINT, 'utf8');
    files.push('copy-styles.css');
  }

  return {
    routes: Object.keys(routeMap),
    files: files.sort(),
    assetsLinked,
    stylesheets,
    warnings,
  };
}

function renderRoute(
  page: PageRecord,
  route: string,
  options: ScaffoldOptions,
  cssFile: string | null,
  images: Array<{ src: string; alt: string }>,
): string {
  const fingerprint = page.fingerprint;
  const landmarks = new Set(fingerprint?.landmarks ?? []);
  const headings = fingerprint?.headings ?? [];
  const headingTexts = new Set(headings.map((heading) => heading.text));
  const links = (fingerprint?.links ?? []).slice(0, 30);
  const escape = (value: string): string =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const body: string[] = [];
  if (landmarks.has('header')) {
    body.push('<header>');
  }
  if (landmarks.has('nav')) {
    body.push(
      `<nav>${links.map((link) => `<a href="${escape(link)}">${escape(link)}</a>`).join('')}</nav>`,
    );
  } else {
    body.push(...links.map((link) => `<a href="${escape(link)}">${escape(link)}</a>`));
  }

  const main: string[] = [];
  for (const heading of headings) {
    const level = Math.min(6, Math.max(1, heading.level));
    main.push(`<h${level}>${escape(heading.text)}</h${level}>`);
  }
  for (const block of fingerprint?.textBlocks ?? []) {
    if (!headingTexts.has(block)) {
      main.push(`<p>${escape(block)}</p>`);
    }
  }
  for (const form of fingerprint?.forms ?? []) {
    main.push(`<form method="${escape(form.method)}">`);
    for (const field of form.fields) {
      const [name, rest] = field.split(':');
      const required = rest?.endsWith('*') === true;
      const type = (rest ?? 'text').replace('*', '');
      main.push(
        `<label>${escape(name ?? '')} <input name="${escape(name ?? '')}" type="${escape(type)}"${required ? ' required' : ''}></label>`,
      );
    }
    main.push('<button type="submit">Submit</button></form>');
  }
  for (const control of fingerprint?.interactive ?? []) {
    main.push(`<button type="button">${escape(control.split(':').pop() ?? control)}</button>`);
  }
  // Prefer the localised files captured by opre.capture_assets; fall back to the
  // fingerprint's alt text with an empty src only when nothing was captured, so
  // Prefer the localised copies captured by opre.capture_assets; fall back to
  // the fingerprint's alt text when the asset pass never ran, so the rebuild
  // still keeps the image slots and the agent sees what is missing.
  const imageMarkup =
    images.length > 0
      ? images.map(
          (image) =>
            `<img alt="${escape(image.alt)}" src="${escape(image.src)}" width="240" height="160">`,
        )
      : (fingerprint?.images ?? []).map(
          (alt) => `<img alt="${escape(alt)}" src="" width="240" height="160">`,
        );
  for (const tag of imageMarkup) {
    main.push(tag);
  }

  if (landmarks.has('main')) {
    body.push('<main>', ...main, '</main>');
  } else {
    body.push(...main);
  }
  if (landmarks.has('aside')) {
    body.push('<aside></aside>');
  }
  if (landmarks.has('footer')) {
    body.push('<footer></footer>');
  }
  if (landmarks.has('header')) {
    body.push('</header>');
  }

  // Link the stylesheet that actually exists for this route. Passing a name that
  // was never written silently gave the rebuild an unstyled page.
  const cssHref =
    options.linkCss && cssFile !== null ? `<link rel="stylesheet" href="styles/${cssFile}">` : '';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(fingerprint?.title ?? page.title ?? 'Rebuild')}</title>`,
    cssHref,
    '</head>',
    `<body data-route="${escape(route)}">`,
    body.join(''),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * Points a raw captured stylesheet at the localised asset copies, so a rebuild
 * still works offline when the research-time CSS is used (its url(...) would
 * otherwise point back at the live target).
 */
function rewriteAssetUrls(
  css: string,
  manifest: { sourceUrl?: string; assets: ManifestAsset[] } | null,
): string {
  if (manifest === null) {
    return css;
  }
  const base = manifest.sourceUrl ?? 'https://placeholder.invalid/';
  const local = new Map<string, string>();
  for (const asset of manifest.assets) {
    if (asset.status !== 'ok' || asset.localPath === null) {
      continue;
    }
    const name = asset.localPath.split('/').pop() ?? 'asset';
    const dir = asset.localPath.split('/')[0] ?? '';
    local.set(asset.url, `../assets/${dir}/${name}`);
  }
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (match, _quote: string, rawUrl: string) => {
      const trimmed = rawUrl.trim();
      if (trimmed.startsWith('data:')) {
        return match;
      }
      let absolute: string;
      try {
        absolute = new URL(trimmed, base).toString();
      } catch {
        return match;
      }
      const replacement = local.get(absolute);
      return replacement === undefined ? match : `url("${replacement}")`;
    },
  );
}

interface ManifestAsset {
  url: string;
  localPath: string | null;
  status: string;
  kind: string;
  alt: string | null;
}

async function readManifest(
  paths: ProjectPaths,
  manifestPath: string,
): Promise<{ sourceUrl?: string; assets: ManifestAsset[] } | null> {
  try {
    const raw = await readFile(resolveInside(paths.root, manifestPath), 'utf8');
    const parsed = JSON.parse(raw) as {
      sourceUrl?: string;
      assets?: Array<Partial<ManifestAsset>>;
    };
    const assets = (parsed.assets ?? []).map((asset) => ({
      url: asset.url ?? '',
      localPath: asset.localPath ?? null,
      status: asset.status ?? 'skipped',
      kind: asset.kind ?? 'other',
      alt: asset.alt ?? null,
    }));
    return { sourceUrl: parsed.sourceUrl, assets };
  } catch {
    return null;
  }
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

const SERVER_SOURCE = `const http = require('node:http');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const map = JSON.parse(readFileSync(join(__dirname, 'routes.json'), 'utf8'));

// Serves the scaffolded copy. Replace this with your own stack once the agent
// has refactored the markup; the point of the scaffold is a running baseline.
http
  .createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const file = map[pathname] ?? (existsSync(join(__dirname, 'index.html')) ? 'index.html' : undefined);
    if (file === undefined) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Not rebuilt yet</h1>');
      return;
    }
    const path = join(__dirname, file);
    if (!existsSync(path)) {
      response.writeHead(404, { 'content-type': 'text/html' });
      response.end('<!doctype html><h1>Not rebuilt yet</h1>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(readFileSync(path, 'utf8'));
  })
  .listen(Number(process.env.PORT || 4173), '127.0.0.1');
`;

const CSS_HINT = `/* Scaffold baseline.
 * The captured stylesheet of the reference is in styles/page-N.css and is linked
 * per route. This file is where shared, refactored styles belong.
 */
`;
