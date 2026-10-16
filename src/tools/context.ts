/**
 * Shared plumbing for MCP tool handlers: project resolution, structured results,
 * response-budget enforcement and progress reporting.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { OpreConfig } from '../config.js';
import { fitToBudget } from '../core/limits.js';
import { toToolError } from '../core/errors.js';
import { resolveProject, type ResolvedProject } from '../project/store.js';

export interface ToolContext {
  config: OpreConfig;
}

export interface ToolDefinition<TSchema> {
  name: string;
  title: string;
  description: string;
  schema: TSchema;
  handler: (
    args: Record<string, unknown>,
    context: ToolContext,
    project: ResolvedProject,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<unknown>;
  readOnlyHint: boolean;
}

export function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Enforces the configured response budget on list payloads by dropping the
 * lowest-priority trailing items and reporting exactly what was removed.
 */
export function budgeted(
  config: OpreConfig,
  payload: Record<string, unknown>,
  listKey: string,
): CallToolResult {
  const {
    payload: fitted,
    droppedItems,
    truncated,
  } = fitToBudget(payload, listKey, config.maxResponseChars);
  if (!truncated) {
    return jsonResult(fitted);
  }
  return jsonResult({
    ...fitted,
    responseBudget: {
      maxChars: config.maxResponseChars,
      droppedItems,
      note: 'Items were dropped to respect the response budget. Narrow the query, use offset/limit, or raise OPRE_MAX_RESPONSE_CHARS.',
    },
  });
}

export function progressReporter(
  server: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): { report: (message: string, progress?: number, total?: number) => Promise<void> } {
  const token = (extra._meta as { progressToken?: number | string } | undefined)?.progressToken;
  return {
    report: async (message: string, progress = 0, total) => {
      if (token === undefined) {
        return;
      }
      try {
        await server.server.notification({
          method: 'notifications/progress',
          params: {
            progressToken: token,
            progress,
            ...(total === undefined ? {} : { total }),
            message,
          },
        });
      } catch {
        // Progress notifications are best-effort and must never fail a tool call.
      }
    },
  };
}

export async function resolveProjectOrThrow(
  config: OpreConfig,
  reference: unknown,
): Promise<ResolvedProject> {
  const value = typeof reference === 'string' ? reference : undefined;
  return resolveProject(config, value);
}

export function toToolResult(error: unknown): CallToolResult {
  return toToolError(error);
}

export interface HandlerResult {
  data: Record<string, unknown>;
  /** When set, the payload's list is trimmed to fit the response budget. */
  listKey?: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  project: ResolvedProject,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<HandlerResult>;

/**
 * Wraps a handler with project resolution, error normalisation and response
 * budgeting. Handlers therefore only contain domain logic.
 */
export function toolHandler(
  config: OpreConfig,
  handler: ToolHandler,
): (
  args: unknown,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      const record = (args ?? {}) as Record<string, unknown>;
      const project = await resolveProjectOrThrow(config, record['project']);
      const result = await handler(record, project, extra);
      return result.listKey === undefined
        ? jsonResult(result.data)
        : budgeted(config, result.data, result.listKey);
    } catch (error) {
      return toToolError(error);
    }
  };
}

export function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function argStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

export function argRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function argArray(
  args: Record<string, unknown>,
  key: string,
): Array<Record<string, unknown>> | undefined {
  const value = args[key];
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : undefined;
}

/** Narrows an unknown tool argument to a string without stringifying objects. */
export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Narrows an unknown tool argument to a list of strings. */
export function toStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
