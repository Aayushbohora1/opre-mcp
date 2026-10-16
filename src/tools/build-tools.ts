/** Build-loop tools: prepare task-scoped context and record implementation results. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpreConfig } from '../config.js';
import { InvalidInputError } from '../core/errors.js';
import { appendSection } from '../core/json-store.js';
import { nowIso } from '../core/ids.js';
import { newBuildResult, prepareBuildContext, recordBuildResult } from '../build/context.js';
import { readBuildResults } from '../build/store.js';
import { readFeatures, upsertFeature } from '../knowledge/store.js';
import type { FeatureStatus } from '../knowledge/types.js';
import { getTask, saveTaskStatus } from '../planning/store.js';
import type { TaskRecord } from '../planning/types.js';
import { assertSafeSegment, resolveInside } from '../security/paths.js';
import { refreshProjectIndex } from '../project/index-document.js';
import {
  argArray,
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  asString,
  toolHandler,
} from './context.js';

const projectParam = z.string().describe('Project name or id.');

export function registerBuildTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.prepare_build_context',
    {
      title: 'Prepare build context for a task',
      description:
        'Returns the minimum context needed to implement one task: the task, its features and acceptance criteria, the supporting findings and evidence, relevant researched routes, recent decisions, previous attempts, the state of app/ and the validation plan. Bounded to a fixed character budget; dropped sections are reported so you can request them explicitly.',
      inputSchema: {
        project: projectParam,
        taskId: z.string().describe('Task to prepare context for (from opre.get_next_task).'),
        includeEvidence: z
          .boolean()
          .optional()
          .describe('Include evidence observations (default true).'),
        query: z.string().optional().describe('Extra search terms to bias finding selection.'),
        maxChars: z
          .number()
          .int()
          .optional()
          .describe(
            'Character budget for this response (defaults to 70% of OPRE_MAX_RESPONSE_CHARS).',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const taskId = argString(record, 'taskId');
      if (taskId === undefined) {
        throw new InvalidInputError('taskId is required.');
      }
      assertSafeSegment(taskId, 'task id');
      const context = await prepareBuildContext(
        project.paths,
        { name: project.manifest.name, target: project.manifest.target },
        {
          taskId,
          includeEvidence: argBoolean(record, 'includeEvidence') ?? true,
          query: argString(record, 'query'),
          maxChars: argNumber(record, 'maxChars'),
        },
        config,
      );
      return { data: context as unknown as Record<string, unknown> };
    }),
  );

  server.registerTool(
    'opre.record_implementation_result',
    {
      title: 'Record an implementation result',
      description:
        'Stores what you actually did for a task: files changed, commands run and their exit codes, which acceptance criteria are met, and the gaps you found. The task status, feature status and knowledge gaps are updated, so the next session continues where you stopped.',
      inputSchema: {
        project: projectParam,
        taskId: z.string(),
        outcome: z.enum(['succeeded', 'partial', 'failed']),
        summary: z.string().describe('What you implemented, in a few sentences.'),
        changedFiles: z
          .array(z.string())
          .optional()
          .describe('Project-relative paths you created or modified.'),
        commandsRun: z
          .array(
            z.object({
              command: z.string(),
              exitCode: z.number().int().nullable(),
              note: z.string().optional(),
            }),
          )
          .optional(),
        acceptanceResults: z
          .array(
            z.object({
              criterion: z.string(),
              met: z.boolean(),
              note: z.string().optional(),
            }),
          )
          .optional(),
        gaps: z
          .array(z.object({ summary: z.string(), severity: z.enum(['low', 'medium', 'high']) }))
          .optional()
          .describe('What you could not complete or could not verify.'),
        nextSteps: z.array(z.string()).optional(),
        taskStatus: z
          .enum(['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'])
          .optional()
          .describe(
            'Task status after this attempt (default: done on success, failed on failure).',
          ),
        featureStatusUpdates: z
          .array(
            z.object({
              featureId: z.string(),
              status: z.enum([
                'proposed',
                'specified',
                'implemented',
                'verified',
                'blocked',
                'dropped',
              ]),
            }),
          )
          .optional(),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const taskId = argString(record, 'taskId');
      if (taskId === undefined) {
        throw new InvalidInputError('taskId is required.');
      }
      assertSafeSegment(taskId, 'task id');
      const task = await getTask(project.paths, taskId);
      const outcome = (argString(record, 'outcome') ?? 'succeeded') as
        'succeeded' | 'partial' | 'failed';
      const summary = argString(record, 'summary') ?? '';

      const changedFiles = (argStringArray(record, 'changedFiles') ?? []).map((file) => {
        resolveInside(project.paths.root, file);
        return file;
      });

      const acceptanceResults = (argArray(record, 'acceptanceResults') ?? []).map((entry) => ({
        criterion: asString(entry['criterion']),
        met: entry['met'] === true,
        note: typeof entry['note'] === 'string' ? entry['note'] : '',
      }));

      const gaps = (argArray(record, 'gaps') ?? []).map((gap) => ({
        summary: asString(gap['summary']),
        severity: (['low', 'medium', 'high'].includes(String(gap['severity']))
          ? String(gap['severity'])
          : 'medium') as 'low' | 'medium' | 'high',
      }));

      const result = newBuildResult({
        taskId,
        featureIds: task.featureIds,
        outcome,
        summary,
        changedFiles,
        commandsRun: (argArray(record, 'commandsRun') ?? []).map((entry) => ({
          command: asString(entry['command']),
          exitCode: typeof entry['exitCode'] === 'number' ? entry['exitCode'] : null,
          note: typeof entry['note'] === 'string' ? entry['note'] : '',
        })),
        acceptanceResults,
        gaps,
        nextSteps: argStringArray(record, 'nextSteps') ?? [],
      });
      await recordBuildResult(project.paths, result);

      const defaultStatus: TaskRecord['status'] =
        outcome === 'succeeded' ? 'done' : outcome === 'partial' ? 'in_progress' : 'failed';
      const targetStatus =
        (argString(record, 'taskStatus') as TaskRecord['status'] | undefined) ?? defaultStatus;
      await saveTaskStatus(project.paths, taskId, targetStatus, {
        changedFiles,
        lastResultId: result.id,
        attemptCount: task.attemptCount + 1,
      });

      for (const update of argArray(record, 'featureStatusUpdates') ?? []) {
        const features = await readFeatures(project.paths);
        const feature = features.find((entry) => entry.id === String(update['featureId']));
        if (feature !== undefined) {
          await upsertFeature(project.paths, {
            ...feature,
            status: update['status'] as FeatureStatus,
            updatedAt: nowIso(),
          });
        }
      }

      if (gaps.length > 0) {
        await appendSection(
          project.paths.knownGaps,
          '## Implementation gaps',
          [
            `- Task \`${taskId}\` at ${nowIso()}`,
            ...gaps.map((gap) => `  - [${gap.severity}] ${gap.summary}`),
          ].join('\n'),
        );
      }

      const unmet = acceptanceResults.filter((entry) => !entry.met).map((entry) => entry.criterion);
      const results = await readBuildResults(project.paths);
      await refreshProjectIndex(project.paths, project.manifest);

      return {
        data: {
          resultId: result.id,
          task: { id: taskId, status: targetStatus, attempts: task.attemptCount + 1 },
          unmetAcceptanceCriteria: unmet,
          gapsRecorded: gaps.length,
          totalResults: results.length,
          nextStep:
            outcome === 'succeeded'
              ? 'Run opre.run_validation for this task, then call opre.get_next_task.'
              : 'Fix the reported gaps, then record another result or run validation to capture the current state.',
          storage: 'artifacts/reports/build-results.json',
        },
      };
    }),
  );
}
