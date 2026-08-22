/**
 * Logging contracts. The implementation lives in logging/logger.ts; these
 * types are the frozen surface every other module depends on.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogFields = Record<string, unknown>;

/** One structured record; the only thing that crosses from emitters to output. */
export interface LogRecord {
  /** Epoch ms. */
  time: number;
  level: LogLevel;
  name: string;
  msg: string;
  fields: LogFields;
}

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(name: string): Logger;
}
