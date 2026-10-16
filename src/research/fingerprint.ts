/**
 * Page fingerprints — the "shape" of a page, small enough to store and compare.
 *
 * A fingerprint is captured with exactly the same code for the *reference* target
 * and for the *rebuilt* app, so the two are directly comparable. It is deliberately
 * structural (headings, text, links, forms, interactive elements, design tokens)
 * plus an optional screenshot for a pixel diff: that is what lets OPRE say
 * "this rebuild matches" with a number instead of an opinion.
 */

import type { Page } from 'playwright';

export interface PageFingerprint {
  /** Path + query of the captured URL, so reference and rebuild routes line up. */
  route: string;
  title: string;
  headings: Array<{ level: number; text: string }>;
  landmarks: string[];
  textBlocks: string[];
  links: string[];
  forms: Array<{ signature: string; method: string; fields: string[] }>;
  interactive: string[];
  images: string[];
  tokens: {
    colors: string[];
    fontFamilies: string[];
    fontSizes: string[];
    radii: string[];
  };
  screenshotPath: string | null;
  capturedAt: string;
}

export function emptyFingerprint(route: string): PageFingerprint {
  return {
    route,
    title: '',
    headings: [],
    landmarks: [],
    textBlocks: [],
    links: [],
    forms: [],
    interactive: [],
    images: [],
    tokens: { colors: [], fontFamilies: [], fontSizes: [], radii: [] },
    screenshotPath: null,
    capturedAt: new Date().toISOString(),
  };
}

export interface FingerprintOptions {
  maxTextBlocks?: number;
  maxLinks?: number;
  maxInteractive?: number;
}

/**
 * Reads the structural signature of the page currently loaded.
 * Runs in the browser; see `installTransformShim` for the source-mode caveat.
 */
export async function captureFingerprint(
  page: Page,
  options: FingerprintOptions = {},
): Promise<Omit<PageFingerprint, 'screenshotPath' | 'capturedAt'>> {
  const limits = {
    maxTextBlocks: options.maxTextBlocks ?? 60,
    maxLinks: options.maxLinks ?? 80,
    maxInteractive: options.maxInteractive ?? 60,
  };

  const raw = await page.evaluate((limits) => {
    const normalize = (value: string): string =>
      value
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim();

    const pathOf = (href: string): string => {
      try {
        const url = new URL(href, document.baseURI);
        return `${url.pathname}${url.search}`;
      } catch {
        return '';
      }
    };

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map((node) => ({
        level: Number.parseInt(node.tagName.slice(1), 10),
        text: normalize(node.textContent ?? '').slice(0, 160),
      }))
      .filter((entry) => entry.text.length > 0);

    const landmarks = (
      [
        ['header', 'header, [role="banner"]'],
        ['nav', 'nav, [role="navigation"]'],
        ['main', 'main, [role="main"]'],
        ['aside', 'aside, [role="complementary"]'],
        ['footer', 'footer, [role="contentinfo"]'],
      ] as Array<[string, string]>
    )
      .filter(([, selector]) => document.querySelector(selector) !== null)
      .map(([name]) => name);

    const textBlocks = Array.from(
      document.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, figcaption, td'),
    )
      .map((node) => normalize(node.textContent ?? ''))
      .filter((text) => text.length > 3 && text.length < 400)
      .slice(0, limits.maxTextBlocks);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((node) => pathOf(node.getAttribute('href') ?? ''))
      .filter((value) => value !== '' && !value.startsWith('javascript:'))
      .slice(0, limits.maxLinks);

    const forms = Array.from(document.querySelectorAll('form')).map((form) => {
      const fields = Array.from(form.querySelectorAll('input, select, textarea'))
        .map((field) => {
          const name = field.getAttribute('name') ?? field.getAttribute('id') ?? '';
          const type = field.getAttribute('type') ?? field.tagName.toLowerCase();
          return `${name}:${type}${field.hasAttribute('required') ? '*' : ''}`;
        })
        .filter((value) => value !== ':');
      const method = (form.getAttribute('method') ?? 'get').toLowerCase();
      const action = pathOf(form.getAttribute('action') ?? '');
      return { signature: `${method} ${action} [${fields.join(', ')}]`, method, fields };
    });

    const interactive = Array.from(
      document.querySelectorAll(
        'button, [role="button"], input[type="submit"], summary, [onclick]',
      ),
    )
      .map((node) => {
        const label = normalize(
          node.getAttribute('aria-label') ?? node.textContent ?? node.getAttribute('name') ?? '',
        ).slice(0, 80);
        const role = node.getAttribute('role') ?? node.tagName.toLowerCase();
        return label === '' ? role : `${role}:${label}`;
      })
      .slice(0, limits.maxInteractive);

    const images = Array.from(document.querySelectorAll('img'))
      .map((node) => normalize(node.getAttribute('alt') ?? '').slice(0, 80))
      .filter((alt) => alt !== '')
      .slice(0, 40);

    const elements = Array.from(document.querySelectorAll('body *')).slice(0, 400);
    const colors = new Set<string>();
    const fontFamilies = new Set<string>();
    const fontSizes = new Set<string>();
    const radii = new Set<string>();
    for (const element of elements) {
      const style = window.getComputedStyle(element);
      if (style.color !== '') {
        colors.add(style.color);
      }
      if (style.backgroundColor !== '' && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        colors.add(style.backgroundColor);
      }
      if (style.fontFamily !== '') {
        fontFamilies.add((style.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim());
      }
      if (style.fontSize !== '') {
        fontSizes.add(style.fontSize);
      }
      if (style.borderRadius !== '' && style.borderRadius !== '0px') {
        radii.add(style.borderRadius);
      }
    }

    const sorted = (values: Set<string>): string[] => [...values].sort().slice(0, 25);

    return {
      route: `${window.location.pathname}${window.location.search}`,
      title: normalize(document.title).slice(0, 160),
      headings,
      landmarks,
      textBlocks: Array.from(new Set(textBlocks)),
      links: Array.from(new Set(links)),
      forms,
      interactive: Array.from(new Set(interactive)),
      images: Array.from(new Set(images)),
      tokens: {
        colors: sorted(colors),
        fontFamilies: sorted(fontFamilies),
        fontSizes: sorted(fontSizes),
        radii: sorted(radii),
      },
    };
  }, limits);

  return raw;
}

/** Stable short hash, used to skip re-comparing unchanged pages. */
export function fingerprintHash(fingerprint: PageFingerprint): string {
  const material = JSON.stringify({
    route: fingerprint.route,
    title: fingerprint.title,
    headings: fingerprint.headings,
    landmarks: fingerprint.landmarks,
    textBlocks: fingerprint.textBlocks,
    links: fingerprint.links,
    forms: fingerprint.forms.map((form) => form.signature),
    interactive: fingerprint.interactive,
    images: fingerprint.images,
    tokens: fingerprint.tokens,
  });
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
