/**
 * Error taxonomy. See DESIGN.md section 3.
 *
 * Rule of thumb: startup throws, inbound logs.
 *
 * Code prefixes tell plugin authors whose fault an error is:
 * - PLUGIN_*  -> the plugin author's bug
 * - CONFIG_, ADAPTER_, COMMAND_, PERMISSION_, RATE_LIMIT_, STORAGE_ ->
 *   framework or platform layer.
 */

import type { LogLevel } from "./logging/types.js";

export type PlugbotErrorCode =
  | "CONFIG_INVALID"
  | "ADAPTER_CAPABILITY_MISSING"
  | "ADAPTER_OPERATION_FAILED"
  | "PLUGIN_LOAD_FAILED"
  | "PLUGIN_HANDLER_FAILED"
  | "PLUGIN_HANDLER_TIMEOUT"
  | "PLUGIN_CIRCUIT_OPEN"
  | "COMMAND_UNKNOWN"
  | "COMMAND_ARGUMENT_INVALID"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "STORAGE_FAILED";

export class PlugbotError extends Error {
  readonly code: PlugbotErrorCode;
  /** Structured detail; rendered as key=value in logs. */
  readonly fields: Readonly<Record<string, unknown>>;

  constructor(code: PlugbotErrorCode, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.fields = fields;
  }
}

/** Startup configuration problem. Thrown; process exits 2. */
export class ConfigError extends PlugbotError {
  constructor(message: string, fields: Record<string, unknown> = {}) {
    super("CONFIG_INVALID", message, fields);
  }
}

/** One validated violation, rendered per DESIGN.md section 6. */
export interface ConfigViolation {
  key: string;
  expectation: string;
  actual: string;
  source: string;
}

/** An adapter operation the adapter declared it does not support. */
export class CapabilityError extends PlugbotError {
  constructor(adapterName: string, operation: string) {
    super(
      "ADAPTER_CAPABILITY_MISSING",
      `adapter "${adapterName}" does not support ${operation}; check capabilities before calling`,
      { adapter: adapterName, operation },
    );
  }
}

/** Transport-level failure during an adapter operation. */
export class AdapterOperationError extends PlugbotError {
  constructor(
    adapterName: string,
    operation: string,
    cause: unknown,
    options: { reconnecting?: boolean } = {},
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super("ADAPTER_OPERATION_FAILED", `adapter "${adapterName}" failed during ${operation}: ${reason}`, {
      adapter: adapterName,
      operation,
      ...(options.reconnecting === true ? { reconnecting: true } : {}),
    });
    this.cause = cause;
  }
}

/** Plugin file could not be imported or does not export a valid spec. */
export class PluginLoadError extends PlugbotError {
  constructor(pluginFile: string, reason: string, cause?: unknown) {
    super("PLUGIN_LOAD_FAILED", `plugin "${pluginFile}" failed to load: ${reason}`, {
      pluginFile,
      reason,
    });
    if (cause !== undefined) this.cause = cause;
  }
}

/** A handler threw or rejected inside a plugin. Contained and logged. */
export class HandlerError extends PlugbotError {
  constructor(pluginName: string, handlerKind: string, handlerName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      "PLUGIN_HANDLER_FAILED",
      `plugin "${pluginName}" ${handlerKind} "${handlerName}" failed: ${reason}`,
      { plugin: pluginName, handlerKind, handler: handlerName },
    );
    this.cause = cause;
  }
}

/** A handler exceeded its timeout. The worker is terminated. */
export class HandlerTimeoutError extends PlugbotError {
  constructor(pluginName: string, handlerKind: string, handlerName: string, timeoutMs: number) {
    super(
      "PLUGIN_HANDLER_TIMEOUT",
      `plugin "${pluginName}" ${handlerKind} "${handlerName}" exceeded ${timeoutMs}ms and was terminated`,
      { plugin: pluginName, handlerKind, handler: handlerName, timeoutMs },
    );
  }
}

/** Invocation attempted while the plugin's breaker is open. */
export class CircuitOpenError extends PlugbotError {
  constructor(pluginName: string, retryAtMs: number) {
    super("PLUGIN_CIRCUIT_OPEN", `plugin "${pluginName}" is temporarily unavailable`, {
      plugin: pluginName,
      retryAtMs,
    });
  }
}

export class CommandUnknownError extends PlugbotError {
  constructor(commandPath: string) {
    super("COMMAND_UNKNOWN", `unknown command "${commandPath}"`, { commandPath });
  }
}

export class ArgumentValidationError extends PlugbotError {
  constructor(commandPath: string, problems: string[]) {
    super(
      "COMMAND_ARGUMENT_INVALID",
      `invalid arguments for "${commandPath}": ${problems.join("; ")}`,
      { commandPath, problems: [...problems] },
    );
  }
}

export class PermissionDeniedError extends PlugbotError {
  constructor(commandPath: string, userId: string) {
    super("PERMISSION_DENIED", `user "${userId}" may not run "${commandPath}"`, {
      commandPath,
      userId,
    });
  }
}

export class RateLimitError extends PlugbotError {
  constructor(retryAfterSec: number) {
    super("RATE_LIMITED", `rate limited; retry after ${retryAfterSec}s`, { retryAfterSec });
  }
}

export class StorageError extends PlugbotError {
  constructor(operation: string, namespace: string, cause?: unknown) {
    super("STORAGE_FAILED", `storage ${operation} failed for namespace "${namespace}"`, {
      operation,
      namespace,
    });
    if (cause !== undefined) this.cause = cause;
  }
}

export type { LogLevel };
