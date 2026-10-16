import { describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigError } from '../../src/core/errors.js';
import { loadConfig } from '../../src/config.js';
import {
  createProject,
  listProjects,
  loadProject,
  resolveProject,
} from '../../src/project/store.js';
import { createTestEnv } from '../helpers.js';

describe('loadConfig', () => {
  it('uses ~/.opre when OPRE_HOME is unset', () => {
    const config = loadConfig({});
    expect(config.homeDir.endsWith('opre')).toBe(true);
  });

  it('rejects a relative OPRE_HOME', () => {
    expect(() => loadConfig({ OPRE_HOME: 'relative/path' })).toThrow(ConfigError);
  });

  it('validates numeric bounds', () => {
    expect(() => loadConfig({ OPRE_MAX_ITEMS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ OPRE_MAX_ITEMS: 'many' })).toThrow(ConfigError);
    expect(loadConfig({ OPRE_MAX_ITEMS: '50' }).maxItems).toBe(50);
  });

  it('validates enums and booleans', () => {
    expect(() => loadConfig({ OPRE_WEB_SEARCH_PROVIDER: 'google' })).toThrow(ConfigError);
    expect(() => loadConfig({ OPRE_RUNNER_ENABLED: 'maybe' })).toThrow(ConfigError);
    const config = loadConfig({
      OPRE_WEB_SEARCH_PROVIDER: 'searxng',
      OPRE_SEARXNG_URL: 'https://searx.example',
    });
    expect(config.search.provider).toBe('searxng');
    expect(config.search.searxngUrl).toBe('https://searx.example/');
  });

  it('parses viewports and rejects malformed ones', () => {
    expect(
      loadConfig({ OPRE_RESEARCH_VIEWPORTS: 'desktop:1280x800;mobile:360x740' }).research.viewports,
    ).toHaveLength(2);
    expect(() => loadConfig({ OPRE_RESEARCH_VIEWPORTS: 'nonsense' })).toThrow(ConfigError);
  });
});

describe('project store', () => {
  it('creates the documented directory layout and a manifest', async () => {
    const env = await createTestEnv();
    try {
      const project = await createProject(env.config, {
        target: 'https://example.com/',
        targetType: 'web',
        authorisation: 'test fixture',
      });

      const manifest = JSON.parse(await readFile(project.paths.manifest, 'utf8')) as {
        name: string;
      };
      expect(manifest.name).toMatch(/^example-com-[0-9a-f]{8}$/);
      for (const relativePath of [
        'research/overview.md',
        'research/architecture.md',
        'research/sources.json',
        'research/findings.json',
        'research/pages.json',
        'knowledge/features.json',
        'knowledge/requirements.md',
        'knowledge/decisions.md',
        'knowledge/uncertainties.md',
        'planning/implementation-plan.md',
        'planning/tasks.json',
        'validation/test-results.json',
        'validation/known-gaps.md',
      ]) {
        await expect(readFile(join(project.paths.root, relativePath), 'utf8')).resolves.toBeTypeOf(
          'string',
        );
      }
    } finally {
      await env.cleanup();
    }
  });

  it('keeps projects isolated and resolves them by name and id', async () => {
    const env = await createTestEnv();
    try {
      const first = await createProject(env.config, {
        target: 'https://a.example',
        targetType: 'web',
      });
      const second = await createProject(env.config, {
        target: 'https://b.example',
        targetType: 'web',
      });

      const projects = await listProjects(env.config);
      expect(projects).toHaveLength(2);

      const byName = await resolveProject(env.config, first.manifest.name);
      const byIdPrefix = await resolveProject(env.config, first.manifest.id.slice(0, 8));
      expect(byName.manifest.id).toBe(first.manifest.id);
      expect(byIdPrefix.manifest.id).toBe(first.manifest.id);
      expect((await resolveProject(env.config, second.manifest.name)).manifest.id).toBe(
        second.manifest.id,
      );
    } finally {
      await env.cleanup();
    }
  });

  it('refuses to create a project for a private target by default', async () => {
    const env = await createTestEnv();
    try {
      await expect(
        createProject(env.config, { target: 'http://127.0.0.1:3000', targetType: 'web' }),
      ).rejects.toThrow(/private or local address/);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects unsafe project names', async () => {
    const env = await createTestEnv();
    try {
      await expect(
        createProject(env.config, {
          target: 'https://example.com',
          targetType: 'web',
          name: '../escape',
        }),
      ).rejects.toThrow(/Invalid project name/);
    } finally {
      await env.cleanup();
    }
  });

  it('requires an explicit project when several exist', async () => {
    const env = await createTestEnv();
    try {
      await createProject(env.config, { target: 'https://a.example', targetType: 'web' });
      await createProject(env.config, { target: 'https://b.example', targetType: 'web' });
      await expect(resolveProject(env.config, undefined)).rejects.toThrow(/Multiple projects/);
    } finally {
      await env.cleanup();
    }
  });

  it('reports a clear error when no project exists', async () => {
    const env = await createTestEnv();
    try {
      await expect(resolveProject(env.config, undefined)).rejects.toThrow(/No OPRE projects found/);
    } finally {
      await env.cleanup();
    }
  });

  it('never overwrites an existing project directory', async () => {
    const env = await createTestEnv();
    try {
      const first = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });
      const manifestPath = join(first.paths.root, 'opre.json');
      await writeFile(join(first.paths.root, 'keep.txt'), 'user data', 'utf8');
      const before = await readFile(manifestPath, 'utf8');

      const second = await createProject(env.config, {
        target: 'https://example.com',
        targetType: 'web',
      });

      expect(second.manifest.name).not.toBe(first.manifest.name);
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
      await expect(readFile(join(first.paths.root, 'keep.txt'), 'utf8')).resolves.toBe('user data');

      // Resolving by name still points at the untouched first project.
      const reloaded = await loadProject(env.config, first.manifest.name);
      expect(reloaded.manifest.id).toBe(first.manifest.id);
    } finally {
      await env.cleanup();
    }
  });
});

describe('home cleanup', () => {
  it('removes the temp home', async () => {
    const env = await createTestEnv();
    await createProject(env.config, { target: 'https://example.com', targetType: 'web' });
    const home = env.home;
    await env.cleanup();
    await expect(readFile(join(home, 'anything'), 'utf8')).rejects.toThrow();
    await rm(home, { recursive: true, force: true });
  });
});
