import { stderr } from "node:process";
import type { LogFields, LogLevel, Logger, LogRecord } from "./types.js";

export interface DefaultLoggerOptions {
  level?: LogLevel;
  stream?: { write(chunk: string): void };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function renderValue(value: unknown): string {
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) return value.message;
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function formatRecord(record: LogRecord): string {
  const time = new Date(record.time).toISOString().slice(11, 19);
  const level = record.level.toUpperCase().padEnd(5);
  const name = record.name.padEnd(12);
  const fields = Object.entries(record.fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
  return `${time} ${level} ${name} ${record.msg}${fields.length > 0 ? ` ${fields}` : ""}\n`;
}

export function createDefaultLogger(options: DefaultLoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const stream = options.stream ?? stderr;
  const emit = (level: LogLevel, name: string, msg: string, fields: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    stream.write(formatRecord({ time: Date.now(), level, name, msg, fields }));
  };
  const build = (name: string): Logger => ({
    debug: (msg, fields) => emit("debug", name, msg, fields ?? {}),
    info: (msg, fields) => emit("info", name, msg, fields ?? {}),
    warn: (msg, fields) => emit("warn", name, msg, fields ?? {}),
    error: (msg, fields) => emit("error", name, msg, fields ?? {}),
    child: (childName) => build(`${name}.${childName}`),
  });
  return build("core");
}
