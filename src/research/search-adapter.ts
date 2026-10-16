/**
 * Web-search adapter.
 *
 * OPRE never fabricates search results and never assumes the host agent can
 * browse. A provider must be configured explicitly; otherwise search-backed
 * research returns a clear `unsupported_capability` error while page inspection
 * and the rest of the pipeline keep working.
 */

import type { OpreConfig } from '../config.js';
import { UnsupportedCapabilityError } from '../core/errors.js';
import { redactSecrets } from '../security/untrusted.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  provider: string;
}

export interface SearchOutcome {
  provider: string;
  query: string;
  results: SearchHit[];
  note: string | null;
}

export interface SearchAdapter {
  readonly provider: string;
  isConfigured: boolean;
  search(query: string, limit: number): Promise<SearchOutcome>;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createSearchAdapter(config: OpreConfig): SearchAdapter {
  if (config.search.provider === 'searxng') {
    if (config.search.searxngUrl === null) {
      throw new UnsupportedCapabilityError(
        'OPRE_WEB_SEARCH_PROVIDER=searxng requires OPRE_SEARXNG_URL.',
        {
          hint: 'Set OPRE_SEARXNG_URL to a SearXNG instance that has "json" enabled in its settings.',
        },
      );
    }
    return searxngAdapter(config, config.search.searxngUrl);
  }

  return {
    provider: 'none',
    isConfigured: false,
    search: (query: string) => {
      return Promise.reject(
        new UnsupportedCapabilityError(
          'No web-search provider is configured, so no search results can be produced.',
          {
            hint: 'Set OPRE_WEB_SEARCH_PROVIDER=searxng with OPRE_SEARXNG_URL, or continue with direct page inspection, which needs no search provider.',
            details: { query },
          },
        ),
      );
    },
  };
}

function searxngAdapter(config: OpreConfig, baseUrl: string): SearchAdapter {
  return {
    provider: 'searxng',
    isConfigured: true,
    search: async (query: string, limit: number) => {
      const url = new URL('/search', baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, config.search.timeoutMs);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': config.research.userAgent },
        });
        if (!response.ok) {
          throw new UnsupportedCapabilityError(`SearXNG responded with HTTP ${response.status}.`, {
            hint: 'The instance may have the JSON format disabled; enable it in the SearXNG settings, or point OPRE_SEARXNG_URL at another instance.',
          });
        }
        const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
        const results = (payload.results ?? []).slice(0, limit).map((entry) => ({
          title: redactSecrets(asText(entry['title'])).text.slice(0, 200),
          url: asText(entry['url']),
          snippet: redactSecrets(asText(entry['content'])).text.slice(0, 400),
          provider: 'searxng',
        }));
        return {
          provider: 'searxng',
          query,
          results,
          note:
            results.length === 0
              ? 'The provider returned no results for this query; record the gap in knowledge/uncertainties.md.'
              : null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
