/** Project-management tools: create, list, inspect and configure a project. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFeatures } from '../knowledge/store.js';
import { readFindings, readPages } from '../research/store.js';
import { readRuns } from '../validation/store.js';
import { createProject, listProjects, saveManifest } from '../project/store.js';
import { taskProgress, readTasks } from '../planning/store.js';
import { blockedReason } from '../planning/types.js';
import {
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  asString,
  toToolResult,
  toolHandler,
} from './context.js';
import type { OpreConfig } from '../config.js';
import { InvalidInputError } from '../core/errors.js';

const projectParam = z
  .string()
  .optional()
  .describe('Project name, id, or directory. Omit when only one project exists.');

export function registerProjectTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.create_project',
    {
      title: 'Create an OPRE project',
      description:
        'Creates an isolated, persistent project directory (research/, knowledge/, planning/, artifacts/, validation/, generated-app/) for a website or application target. Call this first; every other OPRE tool needs a project.',
      inputSchema: {
        target: z
          .string()
          .describe(
            'Absolute http(s) URL or local path to the application package you are authorised to analyse.',
          ),
        targetType: z
          .enum(['web', 'app'])
          .describe(
            '"web" for a site to rebuild in the browser, "app" for an application package that will be rebuilt as a web app.',
          ),
        name: z
          .string()
          .optional()
          .describe('Short project name. Generated from the target when omitted.'),
        title: z.string().optional().describe('Human-readable project title.'),
        authorisation: z
          .string()
          .optional()
          .describe(
            'How you are authorised to inspect this target, e.g. "I own this app" or "open-source project, MIT". Recorded in opre.json.',
          ),
        allowedHosts: z
          .array(z.string())
          .optional()
          .describe(
            'Extra hosts the browser may contact during research (CDNs, API hosts). Default: the target host only.',
          ),
        runnerCommand: z
          .string()
          .optional()
          .describe(
            'Command that starts the generated app, e.g. "npm". Used by opre.run_validation.',
          ),
        runnerArgs: z
          .array(z.string())
          .optional()
          .describe('Arguments for runnerCommand, e.g. ["run","dev","--","--port","4173"].'),
        runnerPort: z.number().int().optional().describe('Port the generated app listens on.'),
        startPath: z
          .string()
          .optional()
          .describe('Route used as the validation entry point. Default "/".'),
        appDir: z
          .string()
          .optional()
          .describe(
            'Project-relative directory holding the generated app. Default "generated-app".',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args) => {
      try {
        const record = args as Record<string, unknown>;
        const created = await createProject(config, {
          target: asString(record['target']),
          targetType: record['targetType'] === 'app' ? 'app' : 'web',
          ...(argString(record, 'name') === undefined ? {} : { name: argString(record, 'name')! }),
          ...(argString(record, 'title') === undefined
            ? {}
            : { title: argString(record, 'title')! }),
          ...(argString(record, 'authorisation') === undefined
            ? {}
            : { authorisation: argString(record, 'authorisation')! }),
          ...(argStringArray(record, 'allowedHosts') === undefined
            ? {}
            : { allowedHosts: argStringArray(record, 'allowedHosts')! }),
          ...(argString(record, 'runnerCommand') === undefined
            ? {}
            : { runnerCommand: argString(record, 'runnerCommand')! }),
          ...(argStringArray(record, 'runnerArgs') === undefined
            ? {}
            : { runnerArgs: argStringArray(record, 'runnerArgs')! }),
          ...(argNumber(record, 'runnerPort') === undefined
            ? {}
            : { runnerPort: argNumber(record, 'runnerPort')! }),
          ...(argString(record, 'startPath') === undefined
            ? {}
            : { startPath: argString(record, 'startPath')! }),
          ...(argString(record, 'appDir') === undefined
            ? {}
            : { appDir: argString(record, 'appDir')! }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  project: created.manifest.name,
                  id: created.manifest.id,
                  root: created.paths.root,
                  target: created.manifest.target,
                  targetType: created.manifest.targetType,
                  authorisation: created.manifest.authorisation,
                  created: true,
                  nextSteps: [
                    'Run opre.start_research to collect evidence-backed findings about the target.',
                    'Review opre.get_research_summary, then opre.create_implementation_plan (mode "draft" or "apply").',
                    'Iterate: opre.get_next_task → opre.prepare_build_context → implement → opre.record_implementation_result → opre.run_validation.',
                  ],
                  layout: {
                    research:
                      'research/ (overview.md, architecture.md, sources.json, findings.json, pages.json)',
                    knowledge:
                      'knowledge/ (features.json, requirements.md, decisions.md, uncertainties.md, workflows/)',
                    planning: 'planning/ (implementation-plan.md, tasks.json)',
                    artifacts: 'artifacts/ (screenshots/, reports/)',
                    validation: 'validation/ (test-results.json, known-gaps.md)',
                    generatedApp: 'generated-app/',
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return toToolResult(error);
      }
    },
  );

  server.registerTool(
    'opre.list_projects',
    {
      title: 'List OPRE projects',
      description:
        'Lists every project under OPRE_HOME with its target and identifiers. Use it to discover project names when a tool call needs one.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const projects = await listProjects(config);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  home: config.homeDir,
                  count: projects.length,
                  projects: projects.map((entry) => ({
                    name: entry.name,
                    id: entry.id,
                    target: entry.target,
                    targetType: entry.targetType,
                    path: entry.path,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return toToolResult(error);
      }
    },
  );

  server.registerTool(
    'opre.get_project_status',
    {
      title: 'Get project status',
      description:
        'Compact snapshot of a project: manifest, research counts, feature and task progress, validation state and the next recommended action. Safe to call at any time; it never returns the whole knowledge base.',
      inputSchema: { project: projectParam },
      annotations: { readOnlyHint: true },
    },
    toolHandler(config, async (args, project) => {
      const [features, tasks, pages, findings, runs] = await Promise.all([
        readFeatures(project.paths),
        readTasks(project.paths),
        readPages(project.paths),
        readFindings(project.paths),
        readRuns(project.paths),
      ]);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const open = tasks.filter(
        (task) => task.status === 'pending' || task.status === 'in_progress',
      );
      const ready = open
        .filter((task) => blockedReason(task, byId) === null)
        .sort((a, b) => a.priority - b.priority);
      const failedRuns = runs.filter((run) => run.status !== 'passed');

      const stage =
        pages.length === 0
          ? 'research'
          : tasks.length === 0
            ? 'planning'
            : open.length === 0
              ? 'complete'
              : 'building';

      return {
        data: {
          project: {
            id: project.manifest.id,
            name: project.manifest.name,
            title: project.manifest.title,
            target: project.manifest.target,
            targetType: project.manifest.targetType,
            authorisation: project.manifest.authorisation,
            root: project.paths.root,
            createdAt: project.manifest.createdAt,
          },
          stage,
          counts: {
            pages: pages.length,
            findings: findings.length,
            features: features.length,
            tasks: tasks.length,
            validationRuns: runs.length,
          },
          tasks: taskProgress(tasks),
          featuresByStatus: features.reduce<Record<string, number>>((accumulator, feature) => {
            accumulator[feature.status] = (accumulator[feature.status] ?? 0) + 1;
            return accumulator;
          }, {}),
          validation: {
            lastStatus: runs.at(-1)?.status ?? null,
            failedRuns: failedRuns.length,
            openGaps: runs.reduce((sum, run) => sum + run.gaps.length, 0),
          },
          nextTask:
            ready[0] === undefined
              ? null
              : {
                  id: ready[0].id,
                  title: ready[0].title,
                  kind: ready[0].kind,
                  priority: ready[0].priority,
                },
          recommendedAction: recommend(stage, pages.length, tasks.length, failedRuns.length),
        },
      };
    }),
  );

  server.registerTool(
    'opre.update_project_config',
    {
      title: 'Update project configuration',
      description:
        'Updates project-level settings: dev-server command/args/port, app directory, allowed hosts, package-inspection authorisation and validation attempt limits. Use it before opre.run_validation so OPRE can start the generated app safely.',
      inputSchema: {
        project: z.string().describe('Project name or id.'),
        runnerCommand: z
          .string()
          .optional()
          .describe(
            'Executable that starts the generated app, e.g. "npm", "pnpm", "node", "python". Never a shell string.',
          ),
        runnerArgs: z.array(z.string()).optional().describe('Arguments passed to runnerCommand.'),
        runnerPort: z.number().int().optional().describe('Port the generated app listens on.'),
        startPath: z.string().optional().describe('Route used as the validation entry point.'),
        appDir: z
          .string()
          .optional()
          .describe('Project-relative directory holding the generated app.'),
        allowedHosts: z
          .array(z.string())
          .optional()
          .describe('Hosts the browser may contact besides the target.'),
        packageInspectionAuthorised: z
          .boolean()
          .optional()
          .describe('Set true only when you are authorised to statically inspect the app package.'),
        maxValidationAttempts: z
          .number()
          .int()
          .optional()
          .describe('Validation retries before OPRE stops the loop for a task.'),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const runner = project.manifest.config.runner;
      const command = argString(record, 'runnerCommand');
      const args2 = argStringArray(record, 'runnerArgs');
      const port = argNumber(record, 'runnerPort');
      const startPath = argString(record, 'startPath');
      const appDir = argString(record, 'appDir');
      const allowedHosts = argStringArray(record, 'allowedHosts');
      const authorised = argBoolean(record, 'packageInspectionAuthorised');
      const maxAttempts = argNumber(record, 'maxValidationAttempts');

      if (appDir !== undefined && (appDir.startsWith('/') || appDir.includes('..'))) {
        throw new InvalidInputError('appDir must be a project-relative path without "..".');
      }
      if (maxAttempts !== undefined && (maxAttempts < 1 || maxAttempts > 25)) {
        throw new InvalidInputError('maxValidationAttempts must be between 1 and 25.');
      }

      if (command !== undefined) {
        runner.command = command;
      }
      if (args2 !== undefined) {
        runner.args = args2;
      }
      if (port !== undefined) {
        runner.port = port;
      }
      if (startPath !== undefined) {
        runner.startPath = startPath.startsWith('/') ? startPath : `/${startPath}`;
      }
      if (appDir !== undefined) {
        runner.appDir = appDir;
      }
      if (allowedHosts !== undefined) {
        project.manifest.config.allowedHosts = allowedHosts;
      }
      if (authorised !== undefined) {
        project.manifest.config.packageInspectionAuthorised = authorised;
      }
      if (maxAttempts !== undefined) {
        runner.maxValidationAttempts = maxAttempts;
      }
      await saveManifest(project);

      return {
        data: {
          updated: true,
          config: project.manifest.config,
          nextStep: 'Call opre.run_validation to verify the runner works end to end.',
        },
      };
    }),
  );
}

function recommend(stage: string, pages: number, tasks: number, failedRuns: number): string {
  if (failedRuns > 0) {
    return 'Inspect opre.get_validation_report, fix the recorded gaps, then rerun validation.';
  }
  switch (stage) {
    case 'research':
      return 'Run opre.start_research, then opre.get_research_summary.';
    case 'planning':
      return 'Run opre.create_implementation_plan, then opre.get_next_task.';
    case 'building':
      return 'Run opre.get_next_task and opre.prepare_build_context for the returned task.';
    default:
      return 'All tasks are closed. Record any residual uncertainty in knowledge/uncertainties.md.';
  }
}
