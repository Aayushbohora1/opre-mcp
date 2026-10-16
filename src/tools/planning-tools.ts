/** Planning tools: implementation plans, backlog queries and task status. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OpreConfig } from '../config.js';
import { InvalidInputError } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { appendSection } from '../core/json-store.js';
import { readFeatures } from '../knowledge/store.js';
import type { FeatureRecord } from '../knowledge/types.js';
import { applyPlan, draftPlan, makeTask } from '../planning/planner.js';
import {
  getTask,
  readPlan,
  readTasks,
  saveTaskStatus,
  selectNextTask,
  taskProgress,
  upsertTask,
  writePlan,
} from '../planning/store.js';
import type { BrowserCheckSpec, TaskRecord, TaskStatus } from '../planning/types.js';
import { blockedReason } from '../planning/types.js';
import { paginate } from '../core/limits.js';
import { assertSafeSegment } from '../security/paths.js';
import { refreshProjectIndex } from '../project/index-document.js';
import {
  argArray,
  argBoolean,
  argNumber,
  argString,
  argStringArray,
  asString,
  toStringList,
  toolHandler,
} from './context.js';

const projectParam = z.string().describe('Project name or id.');
const checkSchema = z.object({
  id: z.string().optional(),
  description: z.string(),
  kind: z.enum(['navigate', 'assert_text', 'assert_visible', 'click', 'fill', 'screenshot']),
  target: z.string().nullable().optional(),
  expected: z.string().nullable().optional(),
  screenshot: z.string().nullable().optional(),
});

export function registerPlanningTools(server: McpServer, config: OpreConfig): void {
  server.registerTool(
    'opre.create_implementation_plan',
    {
      title: 'Create the implementation plan',
      description:
        'Turns research into a dependency-ordered backlog. Mode "draft" derives features and tasks from the researched routes (review and refine afterwards); mode "apply" stores exactly the features and tasks you submit, validating task dependencies. Writes planning/plan.md and planning/tasks.json.',
      inputSchema: {
        project: projectParam,
        goal: z
          .string()
          .describe('One-paragraph statement of what the rebuilt application must do.'),
        mode: z
          .enum(['draft', 'apply'])
          .describe('"draft" = OPRE proposes; "apply" = you submit the plan.'),
        maxFeatures: z
          .number()
          .int()
          .optional()
          .describe('Draft mode: maximum routes to turn into features (default 8).'),
        includeValidationTask: z
          .boolean()
          .optional()
          .describe('Draft mode: append an end-to-end validation task (default true).'),
        features: z
          .array(
            z.object({
              id: z.string().optional(),
              name: z.string(),
              summary: z.string(),
              priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
              acceptanceCriteria: z.array(z.string()).optional(),
              findingIds: z.array(z.string()).optional(),
              tags: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe('Apply mode: the features to persist.'),
        tasks: z
          .array(
            z.object({
              id: z.string().optional(),
              title: z.string(),
              description: z.string(),
              kind: z
                .enum(['foundation', 'feature', 'integration', 'validation', 'research'])
                .optional(),
              priority: z.number().int().optional(),
              featureIds: z.array(z.string()).optional(),
              dependsOn: z.array(z.string()).optional(),
              acceptanceCriteria: z.array(z.string()).optional(),
              notes: z.string().optional(),
              validation: z
                .object({
                  command: z.array(z.string()).nullable().optional(),
                  startUrl: z.string().nullable().optional(),
                  checks: z.array(checkSchema).nullable().optional(),
                })
                .optional(),
            }),
          )
          .optional()
          .describe('Apply mode: the tasks to persist, in dependency order.'),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const goal = argString(record, 'goal') ?? '';
      const mode = argString(record, 'mode') ?? 'draft';

      const features = argArray(record, 'features') ?? [];
      const tasks = argArray(record, 'tasks') ?? [];
      const outcome =
        mode === 'apply'
          ? await applyPlan(project.paths, {
              goal,
              features: features.map((feature) => ({
                ...(typeof feature['id'] === 'string' ? { id: feature['id'] } : {}),
                name: asString(feature['name']),
                summary: asString(feature['summary']),
                ...(feature['priority'] === undefined
                  ? {}
                  : { priority: feature['priority'] as FeatureRecord['priority'] }),
                ...(Array.isArray(feature['acceptanceCriteria'])
                  ? { acceptanceCriteria: toStringList(feature['acceptanceCriteria']) }
                  : {}),
                ...(Array.isArray(feature['findingIds'])
                  ? { findingIds: toStringList(feature['findingIds']) }
                  : {}),
                ...(Array.isArray(feature['tags']) ? { tags: toStringList(feature['tags']) } : {}),
              })),
              tasks: tasks.map((task) => ({
                ...(typeof task['id'] === 'string' ? { id: task['id'] } : {}),
                title: asString(task['title']),
                description: asString(task['description']),
                ...(task['kind'] === undefined ? {} : { kind: task['kind'] as TaskRecord['kind'] }),
                ...(typeof task['priority'] === 'number' ? { priority: task['priority'] } : {}),
                ...(Array.isArray(task['featureIds'])
                  ? { featureIds: toStringList(task['featureIds']) }
                  : {}),
                ...(Array.isArray(task['dependsOn'])
                  ? { dependsOn: toStringList(task['dependsOn']) }
                  : {}),
                ...(Array.isArray(task['acceptanceCriteria'])
                  ? { acceptanceCriteria: toStringList(task['acceptanceCriteria']) }
                  : {}),
                ...(typeof task['notes'] === 'string' ? { notes: task['notes'] } : {}),
                ...(task['validation'] === undefined
                  ? {}
                  : { validation: normalizeValidationInput(task['validation']) }),
              })),
            })
          : await draftPlan(project.paths, {
              goal,
              maxFeatures: Math.min(argNumber(record, 'maxFeatures') ?? 8, 40),
              includeValidationTask: argBoolean(record, 'includeValidationTask') ?? true,
            });

      await refreshProjectIndex(project.paths, project.manifest);

      return {
        data: {
          mode: outcome.mode,
          goal: outcome.metadata.goal,
          planDocument: 'planning/plan.md',
          featureCount: outcome.features.length,
          taskCount: outcome.tasks.length,
          orderedTaskIds: outcome.metadata.orderedTaskIds,
          rationale: outcome.metadata.rationale,
          tasks: outcome.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind,
            priority: task.priority,
            dependsOn: task.dependsOn,
            acceptanceCriteria: task.acceptanceCriteria,
          })),
          features: outcome.features.map((feature) => ({
            id: feature.id,
            name: feature.name,
            priority: feature.priority,
            acceptanceCriteria: feature.acceptanceCriteria,
          })),
          warnings: outcome.warnings,
          nextStep:
            'Refine the draft if needed (opre.upsert_task / opre.upsert_feature), then call opre.get_next_task.',
        },
        listKey: 'tasks',
      };
    }),
  );

  server.registerTool(
    'opre.list_tasks',
    {
      title: 'List tasks',
      description:
        'Paginated backlog with status, dependencies and blocked reasons. Use it to review progress without loading every record.',
      inputSchema: {
        project: projectParam,
        status: z
          .enum(['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'])
          .optional(),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const tasks = await readTasks(project.paths);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      const status = argString(record, 'status');
      const filtered =
        status === undefined ? tasks : tasks.filter((task) => task.status === status);
      const page = paginate(
        filtered,
        argNumber(record, 'offset') ?? 0,
        argNumber(record, 'limit') ?? config.maxItems,
        config.maxItems,
      );
      return {
        data: {
          progress: taskProgress(tasks),
          total: page.total,
          returned: page.returned,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
          tasks: page.items.map((task) => ({
            id: task.id,
            title: task.title,
            kind: task.kind,
            status: task.status,
            priority: task.priority,
            featureIds: task.featureIds,
            dependsOn: task.dependsOn,
            blockedBy: blockedReason(task, byId),
            acceptanceCriteria: task.acceptanceCriteria,
          })),
        },
        listKey: 'tasks',
      };
    }),
  );

  server.registerTool(
    'opre.get_next_task',
    {
      title: 'Get the next task',
      description:
        'Highest-priority task whose dependencies are satisfied, with a short readiness check. Call this between build iterations; it is the entry point of the incremental loop.',
      inputSchema: {
        project: projectParam,
        markInProgress: z
          .boolean()
          .optional()
          .describe('Set the task to in_progress (default false).'),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const selection = await selectNextTask(project.paths);
      if (selection.task === null) {
        return {
          data: {
            task: null,
            reason: selection.reason,
            blocked: selection.blocked.map((task) => ({
              id: task.id,
              title: task.title,
              blockedBy: blockedReason(task, new Map()),
            })),
            nextStep:
              'Create or unblock tasks with opre.create_implementation_plan / opre.update_task_status.',
          },
        };
      }
      const task =
        argBoolean(record, 'markInProgress') === true && selection.task.status === 'pending'
          ? await saveTaskStatus(project.paths, selection.task.id, 'in_progress')
          : selection.task;

      return {
        data: {
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            kind: task.kind,
            status: task.status,
            priority: task.priority,
            featureIds: task.featureIds,
            dependsOn: task.dependsOn,
            acceptanceCriteria: task.acceptanceCriteria,
            validation: task.validation,
            notes: task.notes,
          },
          reason: selection.reason,
          blockedCount: selection.blocked.length,
          nextStep:
            'Call opre.prepare_build_context with this task id, implement only this task, then opre.record_implementation_result.',
        },
      };
    }),
  );

  server.registerTool(
    'opre.update_task_status',
    {
      title: 'Update task status',
      description:
        'Moves a task through its lifecycle (pending → in_progress → done/failed/blocked/cancelled) and records notes, changed files and attempt counts. Status survives restarts and drives dependency resolution.',
      inputSchema: {
        project: projectParam,
        taskId: z.string(),
        status: z.enum(['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled']),
        notes: z
          .string()
          .optional()
          .describe(
            'Why the status changed. Appended to knowledge/uncertainties.md when blocked or failed.',
          ),
        changedFiles: z
          .array(z.string())
          .optional()
          .describe('Project-relative files you created or modified.'),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const taskId = argString(record, 'taskId');
      const status = argString(record, 'status') as TaskStatus | undefined;
      if (taskId === undefined || status === undefined) {
        throw new InvalidInputError('taskId and status are required.');
      }
      assertSafeSegment(taskId, 'task id');
      const notes = argString(record, 'notes');
      const updated = await saveTaskStatus(project.paths, taskId, status, {
        ...(notes === undefined ? {} : { notes }),
        ...(argStringArray(record, 'changedFiles') === undefined
          ? {}
          : { changedFiles: argStringArray(record, 'changedFiles')! }),
      });

      if ((status === 'blocked' || status === 'failed') && notes !== undefined) {
        await appendSection(
          project.paths.uncertainties,
          '## Blocked tasks',
          `- ${updated.id} (${status}) at ${nowIso()}: ${notes}`,
        );
      }

      const plan = await readPlan(project.paths);
      await writePlan(project.paths, {
        metadata: plan.metadata,
        tasks: await readTasks(project.paths),
      });

      return {
        data: {
          task: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt },
          nextStep:
            status === 'done'
              ? 'Call opre.get_next_task for the following task.'
              : 'Complete the task, then record it with opre.record_implementation_result.',
        },
      };
    }),
  );

  server.registerTool(
    'opre.upsert_task',
    {
      title: 'Create or update a task',
      description:
        'Writes a single task with acceptance criteria and optional validation checks. Use it to refine a drafted plan or to add follow-up work discovered during implementation.',
      inputSchema: {
        project: projectParam,
        taskId: z.string().optional().describe('Existing task id to update. Omit to create.'),
        title: z.string(),
        description: z.string().optional(),
        kind: z.enum(['foundation', 'feature', 'integration', 'validation', 'research']).optional(),
        priority: z.number().int().optional(),
        status: z
          .enum(['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'])
          .optional(),
        featureIds: z.array(z.string()).optional(),
        dependsOn: z.array(z.string()).optional(),
        acceptanceCriteria: z.array(z.string()).optional(),
        notes: z.string().optional(),
        validation: z
          .object({
            command: z.array(z.string()).nullable().optional(),
            startUrl: z.string().nullable().optional(),
            checks: z.array(checkSchema).nullable().optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false },
    },
    toolHandler(config, async (args, project) => {
      const record = args;
      const existingId = argString(record, 'taskId');
      const existing =
        existingId === undefined
          ? undefined
          : await getTask(project.paths, existingId).catch(() => undefined);
      const features = await readFeatures(project.paths);

      const validationInput = record['validation'] as
        { command?: string[] | null; startUrl?: string | null; checks?: unknown[] } | undefined;

      const base: TaskRecord =
        existing ??
        makeTask({
          title: argString(record, 'title') ?? 'Untitled task',
          description: argString(record, 'description') ?? '',
          kind: (record['kind'] as TaskRecord['kind']) ?? 'feature',
          priority: argNumber(record, 'priority') ?? 100,
          featureIds: argStringArray(record, 'featureIds') ?? [],
          dependsOn: argStringArray(record, 'dependsOn') ?? [],
          acceptanceCriteria: argStringArray(record, 'acceptanceCriteria') ?? [],
          checks: normalizeChecks(validationInput?.checks),
        });

      const updated: TaskRecord = {
        ...base,
        title: argString(record, 'title') ?? base.title,
        description: argString(record, 'description') ?? base.description,
        kind: (record['kind'] as TaskRecord['kind']) ?? base.kind,
        status: (record['status'] as TaskStatus) ?? base.status,
        priority: argNumber(record, 'priority') ?? base.priority,
        featureIds: argStringArray(record, 'featureIds') ?? base.featureIds,
        dependsOn: argStringArray(record, 'dependsOn') ?? base.dependsOn,
        acceptanceCriteria: argStringArray(record, 'acceptanceCriteria') ?? base.acceptanceCriteria,
        notes: argString(record, 'notes') ?? base.notes,
        validation: {
          command:
            validationInput?.command === undefined
              ? base.validation.command
              : validationInput.command,
          startUrl:
            validationInput?.startUrl === undefined
              ? base.validation.startUrl
              : validationInput.startUrl,
          checks:
            validationInput?.checks === undefined
              ? base.validation.checks
              : normalizeChecks(validationInput.checks),
        },
        updatedAt: nowIso(),
      };

      for (const featureId of updated.featureIds) {
        if (!features.some((feature) => feature.id === featureId)) {
          throw new InvalidInputError(`Unknown feature "${featureId}"`, {
            hint: 'Create it first with opre.upsert_feature, or pass the id returned by opre.create_implementation_plan.',
          });
        }
      }

      const saved = await upsertTask(project.paths, updated);
      return {
        data: { task: saved, created: existing === undefined },
      };
    }),
  );
}

function normalizeValidationInput(value: unknown): {
  command: string[] | null;
  startUrl: string | null;
  checks: BrowserCheckSpec[];
} {
  const input = (value ?? {}) as { command?: unknown; startUrl?: unknown; checks?: unknown };
  return {
    command: Array.isArray(input.command) ? toStringList(input.command) : null,
    startUrl: typeof input.startUrl === 'string' ? input.startUrl : null,
    checks: normalizeChecks(Array.isArray(input.checks) ? (input.checks as unknown[]) : undefined),
  };
}

function normalizeChecks(value: unknown[] | undefined | null): BrowserCheckSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const check = entry as Record<string, unknown>;
    const kind = asString(check['kind'], 'navigate') as BrowserCheckSpec['kind'];
    const allowed: BrowserCheckSpec['kind'][] = [
      'navigate',
      'assert_text',
      'assert_visible',
      'click',
      'fill',
      'screenshot',
    ];
    if (!allowed.includes(kind)) {
      throw new InvalidInputError(`Unsupported check kind "${kind}" on check ${index}.`, {
        hint: `Allowed kinds: ${allowed.join(', ')}`,
      });
    }
    return {
      id: typeof check['id'] === 'string' ? check['id'] : `check-${index + 1}`,
      description: asString(check['description'], `Check ${index + 1}`),
      kind,
      target: typeof check['target'] === 'string' ? check['target'] : null,
      expected: typeof check['expected'] === 'string' ? check['expected'] : null,
      screenshot: typeof check['screenshot'] === 'string' ? check['screenshot'] : null,
    };
  });
}
