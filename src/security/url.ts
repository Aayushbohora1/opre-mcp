/**
 * URL validation and SSRF protection.
 *
 * Rules:
 *  - only `http:` and `https:` are accepted (plus loopback `http:` for the local runner);
 *  - credentials in URLs are rejected;
 *  - non-public hosts are blocked unless the operator opts in explicitly;
 *  - every resolved address is checked, which limits DNS-rebinding tricks.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SecurityError } from '../core/errors.js';

export type UrlScope = 'external' | 'local';

export interface UrlPolicy {
  scope: UrlScope;
  allowPrivateNetwork: boolean;
  /** Hosts that are always permitted, in addition to the target host. */
  allowedHosts: string[];
}

const BLOCKED_PROTOCOLS = new Set([
  'file:',
  'data:',
  'blob:',
  'javascript:',
  'ftp:',
  'ws:',
  'wss:',
]);

export function parseUrl(raw: string, policy: UrlPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecurityError(`"${raw}" is not a valid absolute URL`, {
      hint: 'Provide an absolute URL including the scheme, e.g. https://example.com/pricing',
    });
  }

  if (BLOCKED_PROTOCOLS.has(url.protocol)) {
    throw new SecurityError(`URL scheme "${url.protocol}" is not allowed`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityError(`URL scheme "${url.protocol}" is not supported; use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new SecurityError('URLs containing credentials are rejected to avoid leaking secrets');
  }

  const host = normalizeHost(url.hostname);
  if (policy.scope === 'local' && !isLoopbackHost(host)) {
    throw new SecurityError(
      `Local validation targets must use a loopback host (received "${host}")`,
      {
        hint: 'Use http://127.0.0.1:<port> or http://localhost:<port>',
      },
    );
  }
  if (
    policy.scope === 'external' &&
    !policy.allowPrivateNetwork &&
    isBlockedHost(host) &&
    !isExplicitlyAllowed(host, policy)
  ) {
    throw new SecurityError(
      `Host "${host}" is blocked because it resolves to a private or local address`,
      {
        hint: 'Point OPRE at a public target, or set OPRE_ALLOW_PRIVATE_NETWORK=true if you own this host.',
        details: { host },
      },
    );
  }
  return url;
}

/** Validates every address a host resolves to (mitigates DNS rebinding). */
export async function assertHostResolvesToPublicAddress(
  host: string,
  allowPrivateNetwork: boolean,
): Promise<void> {
  if (
    allowPrivateNetwork ||
    isExplicitlyAllowed(host, { scope: 'external', allowPrivateNetwork, allowedHosts: [host] })
  ) {
    return;
  }
  const addresses = await resolveHost(host);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new SecurityError(`Host "${host}" resolves to the private address ${address}`, {
        hint: 'Set OPRE_ALLOW_PRIVATE_NETWORK=true only for services you control.',
        details: { host, address },
      });
    }
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function hostMatches(url: URL, allowedHosts: string[]): boolean {
  const host = normalizeHost(url.hostname);
  return allowedHosts.some((entry) => {
    const candidate = normalizeHost(entry);
    if (candidate === host) {
      return true;
    }
    return host.endsWith(`.${candidate}`);
  });
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '');
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateV4(address);
  }
  if (version === 6) {
    return isPrivateV6(address);
  }
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd'))
    return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateV4(normalized.slice('::ffff:'.length));
  }
  return false;
}

function isBlockedHost(host: string): boolean {
  if (isLoopbackHost(host)) {
    return true;
  }
  return isIP(host) !== 0 ? isPrivateAddress(host) : false;
}

function isExplicitlyAllowed(host: string, policy: UrlPolicy): boolean {
  return policy.allowedHosts.map(normalizeHost).includes(normalizeHost(host));
}

async function resolveHost(host: string): Promise<string[]> {
  if (isIP(host) !== 0) {
    return [host];
  }
  try {
    const results = await lookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    // Resolution failures are surfaced by the HTTP client; treat as blocked here.
    return [];
  }
}
