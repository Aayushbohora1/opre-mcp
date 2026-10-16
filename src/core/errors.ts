/**
 * Typed error hierarchy shared by every OPRE module.
 *
 * Tool handlers never leak raw stack traces: they convert an `OpreError` into a
 * structured, machine-readable tool result via {@link toToolError}.
 */

export type OpreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'security_blocked'
  | 'unsupported_capability'
  | 'research_failed'
  | 'validation_failed'
  | 'io_error'
  | 'config_error'
  | 'internal_error';

export interface OpreErrorOptions {
  /** Actionable next step for the agent or the user. */
  hint?: string;
  /** Structured, JSON-serialisable context (never secrets). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class OpreError extends Error {
  readonly code: OpreErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: OpreErrorCode, message: string, options: OpreErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OpreError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export class InvalidInputError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('invalid_input', message, options);
    this.name = 'InvalidInputError';
  }
}

export class NotFoundError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('not_found', message, options);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('conflict', message, options);
    this.name = 'ConflictError';
  }
}

export class SecurityError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('security_blocked', message, options);
    this.name = 'SecurityError';
  }
}

export class UnsupportedCapabilityError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('unsupported_capability', message, options);
    this.name = 'UnsupportedCapabilityError';
  }
}

export class ResearchError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('research_failed', message, options);
    this.name = 'ResearchError';
  }
}

export class ValidationFailedError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('validation_failed', message, options);
    this.name = 'ValidationFailedError';
  }
}

export class ConfigError extends OpreError {
  constructor(message: string, options: OpreErrorOptions = {}) {
    super('config_error', message, options);
    this.name = 'ConfigError';
  }
}

export interface ToolErrorResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string; [key: string]: unknown }>;
  isError: true;
}

export function isOpreError(value: unknown): value is OpreError {
  return value instanceof OpreError;
}

/** Converts any thrown value into a deterministic, structured tool error. */
export function toToolError(error: unknown): ToolErrorResult {
  const opreError = isOpreError(error) ? error : fromUnknown(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(opreError.toJSON(), null, 2) }],
  };
}

function fromUnknown(error: unknown): OpreError {
  if (error instanceof Error) {
    return new OpreError('internal_error', `Unexpected failure: ${error.message}`, {
      cause: error,
    });
  }
  return new OpreError('internal_error', `Unexpected failure: ${String(error)}`);
}
