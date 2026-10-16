import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOpreServer } from '../../src/server.js';
import { assertInspectionAuthorised, inspectAppPackage } from '../../src/research/app/inspect.js';
import { readAxmlStrings, readDexStrings } from '../../src/research/app/static-strings.js';
import { readZipDirectory, readZipEntry } from '../../src/research/app/zip.js';
import { createProject } from '../../src/project/store.js';
import { readFindings, readSources } from '../../src/research/store.js';
import { createTestEnv, toolJson, type TestEnv } from '../helpers.js';
import { buildAxml, buildDex, buildZip } from '../helpers/package-fixture.js';

const MANIFEST_STRINGS = [
  'manifest',
  'com.acme.tracker',
  'android.permission.INTERNET',
  'android.permission.ACCESS_FINE_LOCATION',
  'com.acme.tracker.MainActivity',
  'com.acme.tracker.SyncService',
];

const DEX_STRINGS = [
  'Lcom/acme/tracker/Api;',
  'Lcom/acme/tracker/ui/DashboardActivity;',
  'https://api.acme.example/v1/sync',
  'https://telemetry.acme.example/collect',
  'Authorization',
];

describe('static string readers', () => {
  it('reads an AXML string pool', () => {
    const result = readAxmlStrings(buildAxml(MANIFEST_STRINGS));
    expect(result.warnings).toHaveLength(0);
    expect(result.strings).toEqual(MANIFEST_STRINGS);
  });

  it('reads a DEX string pool and classifies identifiers and endpoints', () => {
    const info = readDexStrings(buildDex(DEX_STRINGS), { maxStrings: 100 });
    expect(info.version).toBe('035');
    expect(info.stringCount).toBe(DEX_STRINGS.length);
    expect(info.classLikeIdentifiers).toContain('Lcom/acme/tracker/Api;');
    expect(info.urls).toEqual([
      'https://api.acme.example/v1/sync',
      'https://telemetry.acme.example/collect',
    ]);
  });

  it('reads a ZIP central directory and stored entries', () => {
    const archive = buildZip([
      { name: 'AndroidManifest.xml', content: buildAxml(MANIFEST_STRINGS) },
      { name: 'classes.dex', content: buildDex(DEX_STRINGS) },
    ]);
    const directory = readZipDirectory(archive);
    expect(directory.entries.map((entry) => entry.name)).toEqual([
      'AndroidManifest.xml',
      'classes.dex',
    ]);
    const manifest = directory.entries[0]!;
    expect(readZipEntry(archive, manifest).length).toBeGreaterThan(0);
  });
});

describe('package inspection', () => {
  let env: TestEnv;
  let packagePath: string;

  beforeAll(async () => {
    env = await createTestEnv();
    const archive = buildZip([
      { name: 'AndroidManifest.xml', content: buildAxml(MANIFEST_STRINGS) },
      { name: 'classes.dex', content: buildDex(DEX_STRINGS) },
      { name: 'res/layout/activity_main.xml', content: Buffer.from('<x/>') },
      { name: 'assets/config.json', content: Buffer.from('{"env":"prod"}') },
    ]);
    packagePath = join(env.home, 'acme.apk');
    await writeFile(packagePath, archive);
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it('requires explicit authorisation', () => {
    expect(() => assertInspectionAuthorised(false)).toThrow(/authorisation/i);
    expect(() => assertInspectionAuthorised(true)).not.toThrow();
  });

  it('extracts declared capabilities and records limitations', async () => {
    const project = await createProject(env.config, {
      target: packagePath,
      targetType: 'app',
      authorisation: 'fixture owned by the test suite',
    });

    const result = await inspectAppPackage(project.paths.root, {
      packagePath,
      maxEntryBytes: 10_000_000,
      maxDexStrings: 5_000,
    });

    expect(result.entries).toBe(4);
    expect(result.permissions).toContain('android.permission.INTERNET');
    expect(result.components).toContain('com.acme.tracker.MainActivity');
    expect(result.dexStrings.urls).toContain('https://api.acme.example/v1/sync');
    expect(result.findings.every((finding) => finding.limitations.length > 0)).toBe(true);
    expect(result.unknown.join(' ')).toMatch(/Runtime behaviour/);
  });

  it('persists findings and sources through the MCP tool', async () => {
    const project = await createProject(env.config, {
      target: packagePath,
      targetType: 'app',
      authorisation: 'fixture owned by the test suite',
    });
    const { server } = createOpreServer({ config: env.config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = toolJson<{
      package: { permissions: string[]; components: string[]; warnings: string[] };
      explicitlyUnknown: string[];
      guardrails: string[];
      findingsAdded: number;
    }>(
      await client.callTool({
        name: 'opre.inspect_app_package',
        arguments: { project: project.manifest.name, packagePath },
      }),
    );

    expect(result.package.permissions).toContain('android.permission.INTERNET');
    expect(result.package.components.length).toBeGreaterThan(0);
    expect(result.guardrails.join(' ')).toMatch(/no code was decompiled/i);
    expect(result.findingsAdded).toBeGreaterThan(0);

    const findings = await readFindings(project.paths);
    const sources = await readSources(project.paths);
    expect(findings.some((finding) => finding.statement.includes('archive with'))).toBe(true);
    expect(sources.some((source) => source.type === 'package-metadata')).toBe(true);

    const overview = await readFile(join(project.paths.root, 'research/report.md'), 'utf8');
    expect(overview).toContain('Package inspection');

    await client.close();
  });

  it('rejects a web project and a missing package', async () => {
    const web = await createProject(env.config, {
      target: 'https://example.com',
      targetType: 'web',
    });
    const { server } = createOpreServer({ config: env.config });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const wrongType = (await client.callTool({
      name: 'opre.inspect_app_package',
      arguments: { project: web.manifest.name, packagePath },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(wrongType.isError).toBe(true);
    expect(wrongType.content[0]?.text).toContain('security_blocked');

    const app = await createProject(env.config, {
      target: packagePath,
      targetType: 'app',
      authorisation: 'fixture',
    });
    const missing = (await client.callTool({
      name: 'opre.inspect_app_package',
      arguments: { project: app.manifest.name, packagePath: join(env.home, 'nope.apk') },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain('not_found');

    await client.close();
  });
});
