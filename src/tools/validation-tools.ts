/** Validation tools: run acceptance checks locally and read the structured report. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { copyFor } from './catalog.js';
import type { OpreConfig } from '../config.js';
import { NotFoundError, UnsupportedCapabilityError } from '../core/errors.js';
import { truncateChars } from '../core/limits.js';
import type { BrowserCheckSpec } from '../planning/types.js';
import { assertSafeCommandLine } from '../validation/runner.js';
import { runValidation, summariseValidation } from '../validation/run.js';
import { readRuns } from '../validation/store.js';
import {
  argArray,
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  asString,
  progressReporter,
  toToolResult,
  toolHandler,
} from './context.js';
import { resolveProject } from '../project/store.js';

const projectParam = z.string().describe('Project name or id.');
const checkSchema = z.object({
  id: z.string().optional(),
  description: z.string(),
  kind: z.enum(['navigate', 'assert_text', 'assert_visible', 'click', 'fill', 'screenshot']),
  target: z.string().nullable().optional(),
  expected: z.string().nullable().optional(),
  screenshot: z.string().nullable().optional(),
});

export function registerValidationTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.run_validation',
    {
      title: copyFor('opre.run_validation').title,
      description: copyFor('opre.run_validation').description,
      inputSchema: {
        project: projectParam,
        taskId: z
          .string()
          .optional()
          .describe('Task whose validation checks should run. Without it, a root-page check runs.'),
        baseUrl: z
          .string()
          .optional()
          .describe(
            'Validate an already-running server, e.g. "http://127.0.0.1:4173". OPRE never starts or stops it in this mode.',
          ),
        command: z
          .string()
          .optional()
          .describe('Override the start command (executable only, no shell string).'),
        args: z.array(z.string()).optional().describe('Override the start arguments.'),
        port: z.number().int().optional().describe('Override the port.'),
        checks: z
          .array(checkSchema)
          .optional()
          .describe("Explicit checks to run instead of the task's checks."),
        saveScreenshots: z.boolean().optional().describe('Capture screenshots (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args, extra) => {
      const record = args as Record<string, unknown>;
      let project;
      try {
        project = await resolveProject(config, argString(record, 'project'));
      } catch (error) {
        return toToolResult(error);
      }
      try {
        const progress = progressReporter(server, extra);
        const command = argString(record, 'command');
        const args2 = argStringArray(record, 'args');
        if (command !== undefined) {
          assertSafeCommandLine(command, args2 ?? []);
        }
        await progress.report('Preparing validation run', 0, 3);
        const result = await runValidation(config, project.paths, project.manifest, {
          taskId: argString(record, 'taskId'),
          baseUrl: argString(record, 'baseUrl'),
          command,
          args: args2,
          port: argNumber(record, 'port'),
          checks: normalizeChecks(argArray(record, 'checks')),
          compareReference: argBoolean(record, 'compareReference'),
          maxCompareRoutes: argNumber(record, 'maxCompareRoutes'),
          saveScreenshots: argBoolean(record, 'saveScreenshots') ?? true,
        });
        await progress.report('Validation complete', 3, 3);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        if (error instanceof UnsupportedCapabilityError) {
          return toToolResult(error);
        }
        return toToolResult(error);
      }
    },
  );

  server.registerTool(
    'opre.get_validation_report',
    {
      title: copyFor('opre.get_validation_report').title,
      description: copyFor('opre.get_validation_report').description,
      inputSchema: {
        project: projectParam,
        runId: z.string().optional().describe('Return one specific run in detail.'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('Number of recent runs to include (default 10).'),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const runId = argString(record, 'runId');
      const limit = Math.min(argNumber(record, 'limit') ?? 10, 25);
      const summary = await summariseValidation(project.paths);
      const runs = await readRuns(project.paths);

      if (runId !== undefined) {
        const run = runs.find((entry) => entry.id === runId);
        if (run === undefined) {
          throw new NotFoundError(`Unknown validation run "${runId}"`, {
            hint: `Known runs: ${
              runs
                .slice(-10)
                .map((entry) => entry.id)
                .join(', ') || '(none yet)'
            }`,
          });
        }
        return {
          data: {
            run: {
              ...run,
              checks: run.checks.map((check) => ({
                ...check,
                observed: check.observed === null ? null : truncateChars(check.observed, 400).text,
              })),
            },
          },
        };
      }

      return { data: { project: project.manifest.name, limit, ...summary }, listKey: 'recentRuns' };
    }),
  );
}

function normalizeChecks(value: Array<Record<string, unknown>> | undefined): BrowserCheckSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return value.map((check, index) => ({
    id: typeof check['id'] === 'string' ? check['id'] : `check-${index + 1}`,
    description: asString(check['description'], `Check ${index + 1}`),
    kind: check['kind'] as BrowserCheckSpec['kind'],
    target: typeof check['target'] === 'string' ? check['target'] : null,
    expected: typeof check['expected'] === 'string' ? check['expected'] : null,
    screenshot: typeof check['screenshot'] === 'string' ? check['screenshot'] : null,
  }));
}
