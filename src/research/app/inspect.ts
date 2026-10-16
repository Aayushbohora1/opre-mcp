/**
 * `/opreapp` support: authorised static inspection of an application package.
 *
 * Scope limits, stated plainly:
 *  - inspection requires an explicit operator authorisation recorded on the project;
 *  - only *declared* material is read (manifest strings, resource names, DEX
 *    identifier pools) — no logic is recovered and none is claimed to be;
 *  - every result is stored as a finding with limitations, so the agent can
 *    state what is unknown instead of guessing.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { InvalidInputError, NotFoundError, SecurityError } from '../../core/errors.js';
import { nowIso, shortId } from '../../core/ids.js';
import type { ProjectPaths } from '../../project/paths.js';
import { resolveInside } from '../../security/paths.js';
import { upsertSource, writeFindings, readFindings } from '../store.js';
import type { FindingRecord, SourceRecord } from '../types.js';
import { readAxmlStrings, readDexStrings } from './static-strings.js';
import { readZipDirectory, readZipEntry } from './zip.js';

export interface AppInspectionOptions {
  /** Absolute or project-relative path to the .apk/.ipa/.zip archive. */
  packagePath: string;
  maxEntryBytes: number;
  maxDexStrings: number;
}

export interface AppInspectionResult {
  file: string;
  format: string;
  entries: number;
  topLevel: string[];
  permissions: string[];
  components: string[];
  resourceNames: string[];
  dexStrings: { total: number; read: number; urls: string[]; samples: string[] };
  warnings: string[];
  findings: FindingRecord[];
  sources: SourceRecord[];
  unknown: string[];
}

export async function inspectAppPackage(
  projectRoot: string,
  options: AppInspectionOptions,
): Promise<AppInspectionResult> {
  const absolute =
    extname(options.packagePath) === '' && options.packagePath.startsWith('.')
      ? resolveInside(projectRoot, options.packagePath)
      : options.packagePath;

  const info = await stat(absolute).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new NotFoundError(`Package not found: ${absolute}`);
  }
  if (info.size > 2_000_000_000) {
    throw new InvalidInputError('Package exceeds the 2 GB inspection limit.');
  }

  const buffer = await readFile(absolute);
  const archive = readZipDirectory(buffer);
  const warnings = [...archive.warnings];

  const manifestEntry = archive.entries.find((entry) => entry.name === 'AndroidManifest.xml');
  const dexEntries = archive.entries.filter((entry) => /^classes\d*\.dex$/.test(entry.name));
  const resEntries = archive.entries.filter((entry) => entry.name.startsWith('res/'));
  const plistEntry = archive.entries.find(
    (entry) => entry.name === 'Payload/*.app/Info.plist' || entry.name.endsWith('.app/Info.plist'),
  );

  let permissions: string[] = [];
  let components: string[] = [];
  let manifestStrings: string[] = [];
  if (manifestEntry !== undefined) {
    try {
      const manifestBuffer = readZipEntry(buffer, manifestEntry);
      manifestStrings = readAxmlStrings(manifestBuffer).strings;
      permissions = manifestStrings.filter((value) => value.startsWith('android.permission.'));
      components = manifestStrings.filter((value) =>
        /^[\w.]*(Activity|Service|Receiver|Provider|Application)$/.test(value),
      );
    } catch (error) {
      warnings.push(
        `Manifest parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    warnings.push('No AndroidManifest.xml found; this may not be an Android package.');
  }

  const dexStrings: AppInspectionResult['dexStrings'] = {
    total: 0,
    read: 0,
    urls: [],
    samples: [],
  };
  for (const dexEntry of dexEntries.slice(0, 8)) {
    try {
      const dexBuffer = readZipEntry(buffer, dexEntry);
      const info = readDexStrings(dexBuffer, { maxStrings: options.maxDexStrings });
      dexStrings.total += info.stringCount;
      dexStrings.read += info.classLikeIdentifiers.length + info.urls.length;
      dexStrings.urls = dedupe([...dexStrings.urls, ...info.urls]).slice(0, 50);
      dexStrings.samples = dedupe([...dexStrings.samples, ...info.classLikeIdentifiers]).slice(
        0,
        60,
      );
      warnings.push(...info.warnings);
    } catch (error) {
      warnings.push(`${dexEntry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (plistEntry !== undefined) {
    try {
      const plistBuffer = readZipEntry(buffer, plistEntry);
      const plistStrings = plistBuffer.toString('utf8');
      manifestStrings = [...manifestStrings, ...extractPlistStrings(plistStrings)];
    } catch (error) {
      warnings.push(
        `Info.plist parse failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const resourceNames = resEntries
    .map((entry) => entry.name.replace(/^res\//, ''))
    .filter((name) => name.endsWith('.xml') || name.endsWith('.json'))
    .slice(0, 80);

  const topLevel = dedupe(archive.entries.map((entry) => entry.name.split('/')[0] ?? '')).slice(
    0,
    20,
  );

  const fileName = basename(absolute);
  const source: SourceRecord = {
    id: shortId('src'),
    type: 'package-metadata',
    uri: absolute,
    title: `Static inspection of ${fileName}`,
    trust: 'untrusted',
    collectedAt: nowIso(),
    notes: 'Authorised static analysis. Declared strings only; no logic recovered.',
  };

  const stamp = nowIso();
  const findings: FindingRecord[] = [];
  const base = {
    confidence: 'high' as const,
    verification: 'verified' as const,
    featureId: null,
    workflow: null,
    collectedAt: stamp,
    updatedAt: stamp,
  };

  findings.push({
    id: shortId('fnd'),
    kind: 'observed',
    statement: `${fileName} is an archive with ${archive.entries.length} entries (${topLevel.join(', ')}).`,
    sourceIds: [source.id],
    evidence: [
      {
        id: shortId('ev'),
        sourceId: source.id,
        kind: 'observed',
        observation: `Top-level entries: ${topLevel.join(', ') || 'none'}`,
        data: { entries: archive.entries.length },
        collectedAt: stamp,
      },
    ],
    limitations: [
      'Archive contents only; the package was not executed, patched or decompiled to source.',
    ],
    ...base,
  });

  if (permissions.length > 0 || components.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `Declared capabilities: ${[...permissions, ...components].slice(0, 20).join(', ')}.`,
      sourceIds: [source.id],
      evidence: [
        {
          id: shortId('ev'),
          sourceId: source.id,
          kind: 'observed',
          observation: `permissions=${permissions.length}, components=${components.length}`,
          data: { permissions, components },
          collectedAt: stamp,
        },
      ],
      limitations: [
        'String-pool data cannot prove that a permission is actually exercised at runtime.',
        'A web reconstruction must re-implement the user-visible behaviour, not the Android APIs.',
      ],
      ...base,
    });
  }

  if (dexStrings.urls.length > 0) {
    findings.push({
      id: shortId('fnd'),
      kind: 'observed',
      statement: `The package declares ${dexStrings.urls.length} HTTP endpoint(s) in its identifier pool.`,
      sourceIds: [source.id],
      evidence: [
        {
          id: shortId('ev'),
          sourceId: source.id,
          kind: 'observed',
          observation: dexStrings.urls.join('\n'),
          data: { count: dexStrings.urls.length },
          collectedAt: stamp,
        },
      ],
      limitations: [
        'Endpoints are declared literals; they may be unused, dead, or third-party.',
        'Never call a discovered endpoint without explicit operator authorisation.',
      ],
      ...base,
    });
  }

  const unknown = [
    'Runtime behaviour, network calls actually performed, and server-side dependencies.',
    'Business logic, control flow, and any server-authoritative rules.',
    'Content behind authentication, entitlements, or DRM.',
  ];

  return {
    file: absolute,
    format: extname(absolute).replace('.', '') || 'archive',
    entries: archive.entries.length,
    topLevel,
    permissions,
    components,
    resourceNames,
    dexStrings,
    warnings,
    findings,
    sources: [source],
    unknown,
  };
}

export function assertInspectionAuthorised(authorised: boolean): void {
  if (!authorised) {
    throw new SecurityError(
      'Package inspection requires explicit operator authorisation for this project.',
      {
        hint: 'Recreate the project with targetType="app" and an authorisation statement, or set packageInspectionAuthorised=true after confirming you own or may analyse the package.',
      },
    );
  }
}

export function persistInspection(
  paths: ProjectPaths,
  result: AppInspectionResult,
): Promise<{ findings: FindingRecord[]; sources: SourceRecord[] }> {
  return (async () => {
    for (const source of result.sources) {
      await upsertSource(paths, source);
    }
    const existing = await readFindings(paths);
    await writeFindings(paths, [...existing, ...result.findings]);
    return { findings: result.findings, sources: result.sources };
  })();
}

function extractPlistStrings(contents: string): string[] {
  const matches = contents.matchAll(/<string>([^<]{2,200})<\/string>/g);
  return [...matches].map((match) => match[1] ?? '').filter((value) => value.length > 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
