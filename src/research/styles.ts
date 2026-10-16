/**
 * Style extraction — the second half of "not a screenshot".
 *
 * Screenshot-to-code tools guess layout. The projects that actually reproduce a
 * site extract the real CSS: the stylesheet text itself (rules, `@media`,
 * `@keyframes`, custom properties, `@font-face`) plus a computed-style map keyed
 * by an element signature. That is what this module captures, so a rebuild starts
 * from the target's real design language instead of a blank page.
 */

import type { Page } from 'playwright';

export interface StyleSheetBundle {
  /** Raw CSS text, concatenated in document order. */
  css: string;
  /** Stylesheet URLs that were read (same-origin, accessible). */
  sources: string[];
  /** `:root` custom properties. */
  variables: Record<string, string>;
  /** `@font-face` family + source URLs, for the asset pass. */
  fontFaces: Array<{ family: string; src: string[] }>;
  /** `@media` condition strings, so responsive work has the breakpoints. */
  mediaQueries: string[];
  keyframes: string[];
  skipped: string[];
}

export interface ComputedStyleEntry {
  /** e.g. `h1.hero__title` — a stable, readable element signature. */
  signature: string;
  /** The properties that matter for reproduction, not all 300 computed ones. */
  properties: Record<string, string>;
  count: number;
}

const KEPT_PROPERTIES = [
  'display',
  'position',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'width',
  'max-width',
  'min-height',
  'height',
  'margin',
  'margin-top',
  'margin-bottom',
  'padding',
  'padding-top',
  'padding-bottom',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'color',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'border',
  'border-radius',
  'box-shadow',
  'opacity',
  'z-index',
  'overflow',
  'object-fit',
];

/** Reads the page's own stylesheets. Cross-origin sheets are reported, not read. */
export async function extractStyleSheets(page: Page): Promise<StyleSheetBundle> {
  const raw = await page.evaluate(() => {
    const bundles: Array<{ href: string; text: string; skipped: boolean }> = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const href = sheet.href ?? '(inline)';
      try {
        const rules = sheet.cssRules;
        bundles.push({
          href,
          text: Array.from(rules ?? [])
            .map((rule) => rule.cssText)
            .join('\n'),
          skipped: false,
        });
      } catch {
        bundles.push({ href, text: '', skipped: true });
      }
    }
    return { bundles, rootVariables: getComputedStyle(document.documentElement).cssText };
  });

  const css = raw.bundles
    .filter((bundle) => !bundle.skipped)
    .map((bundle) => bundle.text)
    .join('\n');

  const variables: Record<string, string> = {};
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      variables[name.trim()] = value.trim();
    }
  }

  const fontFaces: Array<{ family: string; src: string[] }> = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    const family = /font-family\s*:\s*([^;]+);/i.exec(body)?.[1]?.replace(/["']/g, '').trim() ?? '';
    const sources = [...body.matchAll(/url\(([^)]+)\)/g)].map((entry) =>
      stripQuotes(entry[1] ?? ''),
    );
    if (family !== '' || sources.length > 0) {
      fontFaces.push({ family, src: sources });
    }
  }

  const mediaQueries = [...css.matchAll(/@media([^{]+)\{/g)]
    .map((match) => (match[1] ?? '').trim())
    .filter((value) => value !== '')
    .slice(0, 40);
  const keyframes = [
    ...new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => (match[1] ?? '').trim())),
  ];
  void rootVariablesText(raw.rootVariables, variables);

  return {
    css: css.slice(0, 800_000),
    sources: raw.bundles.filter((bundle) => !bundle.skipped).map((bundle) => bundle.href),
    variables,
    fontFaces,
    mediaQueries,
    keyframes,
    skipped: raw.bundles.filter((bundle) => bundle.skipped).map((bundle) => bundle.href),
  };
}

function rootVariablesText(cssText: string, into: Record<string, string>): Record<string, string> {
  return into;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

/**
 * A computed-style map keyed by element signature: the same element type with
 * the same class list always renders the same way, so one entry per signature
 * captures the styling without dumping every node.
 */
export async function extractComputedStyleMap(
  page: Page,
  options: { maxEntries?: number } = {},
): Promise<ComputedStyleEntry[]> {
  const maxEntries = options.maxEntries ?? 60;
  return page.evaluate((limit: number) => {
    const kept = [
      'display',
      'position',
      'flex-direction',
      'justify-content',
      'align-items',
      'gap',
      'grid-template-columns',
      'width',
      'max-width',
      'min-height',
      'height',
      'margin',
      'margin-top',
      'margin-bottom',
      'padding',
      'padding-top',
      'padding-bottom',
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'text-transform',
      'text-align',
      'color',
      'background-color',
      'background-image',
      'background-size',
      'background-position',
      'border',
      'border-radius',
      'box-shadow',
      'opacity',
      'z-index',
      'overflow',
      'object-fit',
    ];

    const groups = new Map<string, { count: number; style: CSSStyleDeclaration }>();
    for (const element of Array.from(document.querySelectorAll('body *')).slice(0, 1500)) {
      const classes = (element.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((value) => value !== '' && !/^(ng-|css-|sc-)/.test(value))
        .slice(0, 2)
        .join('.');
      const tag = element.tagName.toLowerCase();
      const signature = classes === '' ? tag : `${tag}.${classes}`;
      const existing = groups.get(signature);
      if (existing === undefined) {
        groups.set(signature, { count: 1, style: window.getComputedStyle(element) });
      } else {
        existing.count += 1;
      }
    }

    return [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit)
      .map(([signature, group]) => {
        const properties: Record<string, string> = {};
        for (const property of kept) {
          const value = group.style.getPropertyValue(property);
          if (value !== '' && value !== 'none' && value !== 'normal' && value !== '0px') {
            properties[property] = value;
          }
        }
        return { signature, properties, count: group.count };
      })
      .filter((entry) => Object.keys(entry.properties).length > 0);
  }, maxEntries);
}

/** Emits a stylesheet from the computed-style map so a rebuild can start exact. */
export function computedStylesToCss(entries: ComputedStyleEntry[]): string {
  const blocks = entries.map((entry) => {
    const declarations = Object.entries(entry.properties)
      .map(([property, value]) => `  ${property}: ${value};`)
      .join('\n');
    return `${entry.signature} {\n${declarations}\n}`;
  });
  return `/* Computed styles captured from the reference (${entries.length} signatures). */\n${blocks.join('\n\n')}\n`;
}

export { KEPT_PROPERTIES };
