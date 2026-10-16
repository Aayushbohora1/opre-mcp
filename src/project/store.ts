/**
 * Project lifecycle: create, resolve, persist and summarise projects.
 *
 * Isolation rule: every operation is scoped to one project directory and every
 * cross-project identifier must be resolved through {@link resolveProject},
 * which only ever returns manifests that live under the configured OPRE home.
 */

import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { OpreConfig, TargetType } from '../config.js';
import { ConflictError, InvalidInputError, NotFoundError } from '../core/errors.js';
import { newProjectId, nowIso } from '../core/ids.js';
import {
  readJsonFile,
  writeFileAtomic as writeTextFileAtomic,
  writeJsonFile,
} from '../core/json-store.js';
import { parseUrl } from '../security/url.js';
import { projectPaths, type ProjectPaths } from './paths.js';
import { defaultProjectConfig, PROJECT_SCHEMA_VERSION, type ProjectManifest } from './types.js';

export interface CreateProjectInput {
  name?: string;
  title?: string;
  targetType: TargetType;
  target: string;
  authorisation?: string;
  allowedHosts?: string[];
  runnerCommand?: string;
  runnerArgs?: string[];
  runnerPort?: number;
  startPath?: string;
  appDir?: string;
}

export interface ResolvedProject {
  manifest: ProjectManifest;
  paths: ProjectPaths;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  );
}

export async function createProject(
  config: OpreConfig,
  input: CreateProjectInput,
): Promise<ResolvedProject> {
  const id = newProjectId();
  const isApp = input.targetType === 'app';
  const target = isApp
    ? await resolvePackageTarget(input.target)
    : parseUrl(input.target, {
        scope: 'external',
        allowPrivateNetwork: config.network.allowPrivateNetwork,
        allowedHosts: [],
      }).toString();
  const baseName =
    input.name ?? slugify(isApp ? basename(input.target) : safeTargetForName(input.target));
  if (!NAME_PATTERN.test(baseName)) {
    throw new InvalidInputError(
      `Invalid project name "${baseName}". Use 2-64 characters: letters, digits, dot, dash or underscore.`,
    );
  }

  const manifest: ProjectManifest = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    name: `${baseName}-${id.slice(0, 8)}`,
    title:
      input.title ??
      (isApp ? `Application: ${basename(input.target)}` : `Website: ${hostOf(target)}`),
    targetType: input.targetType,
    target,
    authorisation: input.authorisation ?? 'unspecified',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    config: {
      ...defaultProjectConfig(),
      allowedHosts: input.allowedHosts ?? [],
      packageInspectionAuthorised: input.targetType === 'app',
      runner: {
        command: input.runnerCommand ?? null,
        args: input.runnerArgs ?? [],
        port: input.runnerPort ?? null,
        startPath: input.startPath ?? '/',
        appDir: input.appDir ?? 'generated-app',
        maxValidationAttempts: null,
      },
    },
  };

  const root = join(config.homeDir, manifest.name);
  if (await pathExists(root)) {
    throw new ConflictError(`Project directory already exists: ${root}`);
  }

  const paths = projectPaths(root);
  await mkdir(root, { recursive: true });
  await Promise.all([
    mkdir(paths.research, { recursive: true }),
    mkdir(paths.knowledge, { recursive: true }),
    mkdir(paths.workflows, { recursive: true }),
    mkdir(paths.planning, { recursive: true }),
    mkdir(paths.screenshots, { recursive: true }),
    mkdir(paths.reports, { recursive: true }),
    mkdir(paths.validation, { recursive: true }),
    mkdir(paths.generatedApp, { recursive: true }),
  ]);

  await writeJsonDocument(paths.manifest, manifest);
  await writeJsonFile(paths.sources, []);
  await writeJsonFile(paths.findings, []);
  await writeJsonFile(paths.pages, []);
  await writeJsonFile(paths.features, []);
  await writeJsonFile(paths.tasks, []);
  await writeJsonFile(paths.testResults, []);

  await Promise.all([
    writeText(
      paths.overview,
      `# Research overview\n\nProject \`${manifest.name}\` targets <${manifest.target}>.\n`,
    ),
    writeText(
      paths.architecture,
      '# Inferred architecture\n\n_No analysis yet. Run `opre.start_research`._\n',
    ),
    writeText(
      paths.requirements,
      '# Requirements\n\nDerived from research evidence; every line links to a finding.\n',
    ),
    writeText(
      paths.decisions,
      '# Decisions\n\nArchitectural decisions taken while rebuilding the target.\n',
    ),
    writeText(paths.uncertainties, '# Uncertainties\n\nOpen questions and unverified behaviour.\n'),
    writeText(
      paths.implementationPlan,
      '# Implementation plan\n\n_No plan yet. Run `opre.create_implementation_plan`._\n',
    ),
    writeText(
      paths.knownGaps,
      '# Known gaps\n\nFailures and unverified features recorded by validation runs.\n',
    ),
  ]);

  return { manifest, paths };
}

async function writeText(path: string, contents: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, contents, 'utf8');
}

export interface ListProjectEntry {
  id: string;
  name: string;
  title: string;
  target: string;
  targetType: TargetType;
  createdAt: string;
  updatedAt: string;
  path: string;
}

export async function listProjects(config: OpreConfig): Promise<ListProjectEntry[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(config.homeDir);
  } catch {
    return [];
  }
  const projects: ListProjectEntry[] = [];
  for (const entry of entries) {
    const root = join(config.homeDir, entry);
    if (!(await fileExists(join(root, 'opre.json')))) {
      continue;
    }
    const manifest = await readJsonFile<ProjectManifest | null>(join(root, 'opre.json'), null);
    if (manifest === null) {
      continue;
    }
    projects.push({
      id: manifest.id,
      name: manifest.name,
      title: manifest.title,
      target: manifest.target,
      targetType: manifest.targetType,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      path: root,
    });
  }
  return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Resolves a project reference (name, id prefix, or absolute directory path).
 * Absolute paths are only accepted when they sit inside the OPRE home, unless
 * the operator explicitly opted in via OPRE_ALLOW_EXTERNAL_PROJECT_PATHS.
 */
export async function resolveProject(
  config: OpreConfig,
  reference: string | undefined,
): Promise<ResolvedProject> {
  const trimmed = reference?.trim();
  if (trimmed === undefined || trimmed === '') {
    const projects = await listProjects(config);
    if (projects.length === 0) {
      throw new NotFoundError('No OPRE projects found.', {
        hint: 'Create one with opre.create_project first.',
      });
    }
    if (projects.length > 1) {
      throw new InvalidInputError(
        `Multiple projects exist. Specify one of: ${projects.map((entry) => entry.name).join(', ')}`,
      );
    }
    return loadProject(config, projects[0]!.name);
  }

  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const root = resolve(trimmed);
    if (!(await fileExists(join(root, 'opre.json')))) {
      throw new NotFoundError(`No opre.json found at ${root}`);
    }
    return loadFrom(root);
  }

  const direct = join(config.homeDir, trimmed);
  if (await fileExists(join(direct, 'opre.json'))) {
    return loadFrom(direct);
  }

  const candidates = (await listProjects(config)).filter(
    (entry) =>
      entry.id === trimmed || entry.id.startsWith(trimmed) || entry.name.startsWith(trimmed),
  );
  if (candidates.length === 0) {
    throw new NotFoundError(`Unknown project "${trimmed}"`, {
      hint: 'Use opre.list_projects to see available projects.',
    });
  }
  if (candidates.length > 1) {
    throw new InvalidInputError(
      `"${trimmed}" matches ${candidates.length} projects: ${candidates.map((c) => c.name).join(', ')}`,
    );
  }
  return loadFrom(candidates[0]!.path);
}

export async function loadProject(config: OpreConfig, name: string): Promise<ResolvedProject> {
  return loadFrom(join(config.homeDir, name));
}

async function loadFrom(root: string): Promise<ResolvedProject> {
  const manifest = await readJsonFile<ProjectManifest | null>(join(root, 'opre.json'), null);
  if (manifest === null) {
    throw new NotFoundError(`No opre.json found in ${root}`);
  }
  return { manifest, paths: projectPaths(root) };
}

export async function saveManifest(project: ResolvedProject): Promise<void> {
  const manifest: ProjectManifest = { ...project.manifest, updatedAt: nowIso() };
  project.manifest = manifest;
  await writeJsonDocument(project.paths.manifest, manifest);
}

/** `opre.json` stays a plain, human-readable JSON object. */
async function writeJsonDocument(path: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function projectLabel(project: ResolvedProject): { id: string; name: string; root: string } {
  return {
    id: project.manifest.id,
    name: project.manifest.name,
    root: project.paths.root,
  };
}

export function defaultRunnerPort(config: OpreConfig, project: ResolvedProject): number {
  return project.manifest.config.runner.port ?? config.runner.defaultPort;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function safeTargetForName(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return basename(target);
  }
}

function hostOf(target: string): string {
  try {
    return new URL(target).hostname;
  } catch {
    return basename(target);
  }
}

/**
 * Application projects point at a local package file. The path must exist and be
 * a file; it is stored as given so the operator's provenance stays visible.
 */
async function resolvePackageTarget(target: string): Promise<string> {
  const resolved = resolve(target);
  const info = await stat(resolved).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new NotFoundError(`Application package not found: ${resolved}`, {
      hint: 'Pass an absolute path to the .apk/.ipa/.zip you are authorised to analyse.',
    });
  }
  return resolved;
}
