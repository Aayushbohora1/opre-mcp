/** Project manifest model (`opre.json`). */

import type { TargetType } from '../config.js';

export const PROJECT_SCHEMA_VERSION = 1;

export interface ProjectRunnerConfig {
  /** Command used to start the generated app, relative to the project root. */
  command: string | null;
  /** Extra arguments appended after the command. */
  args: string[];
  /** Port the generated app listens on. */
  port: number | null;
  /** Path served by the app, used as the validation entry point. */
  startPath: string;
  /** Directory (project-relative) that holds the generated application. */
  appDir: string;
  /** Maximum number of validation attempts before OPRE stops the loop. */
  maxValidationAttempts: number | null;
}

export interface ProjectConfig {
  /** Additional hosts the browser may contact besides the research target. */
  allowedHosts: string[];
  /** Whether the operator authorised static inspection of an app package. */
  packageInspectionAuthorised: boolean;
  runner: ProjectRunnerConfig;
}

export interface ProjectManifest {
  schemaVersion: number;
  id: string;
  name: string;
  title: string;
  targetType: TargetType;
  target: string;
  /** Provenance of the authorisation statement supplied by the operator. */
  authorisation: string;
  createdAt: string;
  updatedAt: string;
  config: ProjectConfig;
}

export function defaultProjectConfig(): ProjectConfig {
  return {
    allowedHosts: [],
    packageInspectionAuthorised: false,
    runner: {
      command: null,
      args: [],
      port: null,
      startPath: '/',
      appDir: 'generated-app',
      maxValidationAttempts: null,
    },
  };
}

export function runnerPort(manifest: ProjectManifest, fallbackPort: number): number {
  return manifest.config.runner.port ?? fallbackPort;
}
