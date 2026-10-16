/**
 * Validation orchestrator: the research → build → test feedback loop.
 *
 * It starts the configured local server (or reuses one the operator already
 * runs), executes the task's browser checks, records a structured run, writes the
 * failures into `validation/known-gaps.md`, and stops retrying once the
 * configured attempt limit is reached.
 */

import type { OpreConfig } from '../config.js';
import {
  NotFoundError,
  UnsupportedCapabilityError,
  ValidationFailedError,
} from '../core/errors.js';
import { shortId } from '../core/ids.js';
import { getTask, readTasks } from '../planning/store.js';
import type { BrowserCheckSpec, TaskRecord } from '../planning/types.js';
import type { ProjectPaths } from '../project/paths.js';
import type { ProjectManifest } from '../project/types.js';
import { resolveInside } from '../security/paths.js';
import { parseUrl } from '../security/url.js';
import { checksForTask, runBrowserChecks } from './browser-checks.js';
import { resolveServerSpec, startDevServer, waitForPort, type DevServerHandle } from './runner.js';
import { appendKnownGaps, appendRun, readRuns } from './store.js';
import type { ValidationRunRecord, ValidationStatus } from './types.js';

export interface RunValidationOptions {
  taskId?: string;
  /** Reuse an already-running server instead of spawning one. */
  baseUrl?: string;
  command?: string;
  args?: string[];
  port?: number;
  checks?: BrowserCheckSpec[];
  saveScreenshots?: boolean;
}

export interface RunValidationResult {
  runId: string;
  status: ValidationStatus;
  attemptNumber: number;
  attemptsRemaining: number;
  target: string;
  checks: Array<{
    id: string;
    status: string;
    description: string;
    observed: string | null;
    error: string | null;
  }>;
  screenshots: string[];
  consoleErrors: string[];
  failedRequests: string[];
  gaps: string[];
  reportPath: string;
  nextAction: string;
  stopped: boolean;
  stopReason: string | null;
}

export async function runValidation(
  config: OpreConfig,
  paths: ProjectPaths,
  manifest: ProjectManifest,
  options: RunValidationOptions = {},
): Promise<RunValidationResult> {
  const task: TaskRecord | null =
    options.taskId === undefined ? null : await getTask(paths, options.taskId);
  const runs = await readRuns(paths);
  const priorRuns = runs.filter((run) => run.taskId !== null && run.taskId === task?.id);
  const maxAttempts =
    manifest.config.runner.maxValidationAttempts ?? config.runner.maxValidationAttempts;
  const attemptNumber = priorRuns.length + 1;

  if (priorRuns.length >= maxAttempts) {
    throw new ValidationFailedError(
      `Validation attempt limit reached for this task (${maxAttempts} of ${maxAttempts} used).`,
      {
        hint: 'Raise OPRE_MAX_VALIDATION_ATTEMPTS or set runner.maxValidationAttempts in opre.update_project_config, or record a human decision in knowledge/decisions.md before continuing.',
        details: { lastRunId: priorRuns.at(-1)?.id ?? null },
      },
    );
  }

  const startPath = task?.validation.startUrl ?? manifest.config.runner.startPath;
  const checks =
    options.checks !== undefined && options.checks.length > 0
      ? options.checks
      : checksForTask(task, startPath);
  const runId = shortId('val');

  let server: DevServerHandle | null = null;
  let target = options.baseUrl ?? '';
  let serverStarted = false;
  let commandUsed: string | null = null;

  try {
    if (options.baseUrl !== undefined && options.baseUrl !== '') {
      target = parseUrl(options.baseUrl, {
        scope: 'local',
        allowPrivateNetwork: true,
        allowedHosts: [],
      }).toString();
      const port = portFromUrl(target);
      if (port === null || !(await waitForPort(port, 1_000))) {
        throw new ValidationFailedError(`No server is reachable at ${target}.`, {
          hint: 'Start the app first, or let OPRE start it by configuring runnerCommand/runnerArgs.',
        });
      }
    } else {
      const spec = resolveServerSpec(config, paths, manifest, {
        ...(options.command === undefined ? {} : { command: options.command }),
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.port === undefined ? {} : { port: options.port }),
      });
      commandUsed = `${spec.command} ${spec.args.join(' ')}`.trim();
      server = await startDevServer(config, spec);
      target = server.baseUrl;
      serverStarted = true;
    }

    const outcome = await runBrowserChecks(config, paths, {
      baseUrl: target,
      checks,
      screenshotDir: resolveInside(paths.root, 'artifacts/screenshots'),
      timeoutMs: config.runner.requestTimeoutMs,
      saveScreenshots: options.saveScreenshots ?? true,
    });

    const failed = outcome.results.filter((result) => result.status !== 'passed');
    const gaps = [
      ...failed.map(
        (result) =>
          `${result.id}: ${result.description} — ${result.error ?? `expected ${result.expected ?? 'success'}, observed ${result.observed ?? 'nothing'}`}`,
      ),
      ...(outcome.consoleErrors.length > 0
        ? [`Console errors observed: ${outcome.consoleErrors.slice(0, 3).join(' | ')}`]
        : []),
      ...(outcome.failedRequests.length > 0
        ? [`Failed requests observed: ${outcome.failedRequests.slice(0, 3).join(' | ')}`]
        : []),
    ];

    const run: ValidationRunRecord = {
      id: runId,
      taskId: task?.id ?? null,
      featureIds: task?.featureIds ?? [],
      target,
      status: failed.length === 0 ? 'passed' : 'failed',
      startedAt: new Date(
        Date.now() - outcome.results.reduce((sum, check) => sum + check.durationMs, 0),
      ).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: outcome.results.reduce((sum, check) => sum + check.durationMs, 0),
      server: {
        started: serverStarted,
        command: commandUsed,
        port: portFromUrl(target) ?? 0,
        // A recorded run implies the server started; startup failures throw instead.
        error: null,
      },
      checks: outcome.results,
      screenshots: outcome.screenshots,
      consoleErrors: outcome.consoleErrors,
      failedRequests: outcome.failedRequests,
      gaps,
      attemptNumber,
      notes: `Browser: ${outcome.browserLaunch}`,
    };

    await appendRun(paths, run);
    await appendKnownGaps(paths, gaps, runId);

    const attemptsRemaining = maxAttempts - attemptNumber;
    const stopped = failed.length > 0 && attemptsRemaining <= 0;

    return {
      runId,
      status: run.status,
      attemptNumber,
      attemptsRemaining,
      target,
      checks: outcome.results.map((result) => ({
        id: result.id,
        status: result.status,
        description: result.description,
        observed: result.observed,
        error: result.error,
      })),
      screenshots: outcome.screenshots,
      consoleErrors: outcome.consoleErrors,
      failedRequests: outcome.failedRequests,
      gaps,
      reportPath: 'validation/test-results.json',
      nextAction:
        failed.length === 0
          ? 'Mark the task done with opre.update_task_status, then take the next task with opre.get_next_task.'
          : stopped
            ? 'Attempt limit reached. Review validation/known-gaps.md, record a decision, or raise the limit before retrying.'
            : `Fix the failing checks, then rerun opre.run_validation for ${task?.id ?? 'the project'} (${attemptsRemaining} attempt(s) left).`,
      stopped,
      stopReason: stopped ? 'attempt limit reached' : null,
    };
  } catch (error) {
    if (error instanceof UnsupportedCapabilityError || error instanceof ValidationFailedError) {
      throw error;
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    await server?.stop();
  }
}

export interface ValidationReportSummary {
  totalRuns: number;
  lastRun: {
    id: string;
    status: string;
    finishedAt: string;
    taskId: string | null;
    failures: number;
  } | null;
  failuresByTask: Array<{ taskId: string; failures: number; lastStatus: string }>;
  openGaps: number;
  recentRuns: Array<{
    id: string;
    status: string;
    taskId: string | null;
    finishedAt: string;
    failures: number;
    attemptNumber: number;
  }>;
  path: string;
}

export async function summariseValidation(paths: ProjectPaths): Promise<ValidationReportSummary> {
  const runs = await readRuns(paths);
  const recent = runs.slice(-10).reverse();
  const byTask = new Map<string, { failures: number; lastStatus: string }>();
  for (const run of runs) {
    if (run.taskId === null) {
      continue;
    }
    const entry = byTask.get(run.taskId) ?? { failures: 0, lastStatus: run.status };
    entry.failures += run.checks.filter((check) => check.status !== 'passed').length;
    entry.lastStatus = run.status;
    byTask.set(run.taskId, entry);
  }
  const last = runs.at(-1);
  return {
    totalRuns: runs.length,
    lastRun:
      last === undefined
        ? null
        : {
            id: last.id,
            status: last.status,
            finishedAt: last.finishedAt,
            taskId: last.taskId,
            failures: last.checks.filter((check) => check.status !== 'passed').length,
          },
    failuresByTask: [...byTask.entries()]
      .map(([taskId, value]) => ({
        taskId,
        failures: value.failures,
        lastStatus: value.lastStatus,
      }))
      .sort((a, b) => b.failures - a.failures),
    openGaps: runs.reduce((sum, run) => sum + run.gaps.length, 0),
    recentRuns: recent.map((run) => ({
      id: run.id,
      status: run.status,
      taskId: run.taskId,
      finishedAt: run.finishedAt,
      failures: run.checks.filter((check) => check.status !== 'passed').length,
      attemptNumber: run.attemptNumber,
    })),
    path: 'validation/test-results.json',
  };
}

export async function requireTaskForValidation(paths: ProjectPaths, taskId: string): Promise<void> {
  const tasks = await readTasks(paths);
  if (!tasks.some((task) => task.id === taskId)) {
    throw new NotFoundError(`Unknown task "${taskId}"`);
  }
}

function portFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    return parsed.port === ''
      ? parsed.protocol === 'https:'
        ? 443
        : 80
      : Number.parseInt(parsed.port, 10);
  } catch {
    return null;
  }
}
