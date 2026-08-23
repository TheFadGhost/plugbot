import type { Logger } from "./types.js";
import { applyTheme, type ThemeName } from "./themes.js";
import type { LogFields, LogLevel, LogRecord, LogSink } from "./types.js";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const LEVEL_TOKENS: Record<LogLevel, "levelDebug" | "levelInfo" | "levelWarn" | "levelError"> = {
  debug: "levelDebug",
  info: "levelInfo",
  warn: "levelWarn",
  error: "levelError",
};

export interface CreateLoggerOptions {
  sink?: LogSink;
  stream?: { write(s: string): void };
  level?: LogLevel;
  json?: boolean;
  theme?: ThemeName;
  color?: boolean;
  env?: Record<string, string | undefined>;
}

export interface RecordFormat {
  json: boolean;
  theme: ThemeName;
  colorEnabled: boolean;
}

export function decideColour(
  stream: { write(s: string): void } | undefined,
  colorOpt: boolean | undefined,
  env: Record<string, string | undefined> | undefined,
): boolean {
  if (colorOpt !== undefined) return colorOpt;
  if (env !== undefined && Object.hasOwn(env, "NO_COLOR")) return false;
  if (stream !== undefined && (stream as { isTTY?: unknown }).isTTY === true) return true;
  return false;
}

function localHms(epochMs: number): string {
  const date = new Date(epochMs);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function renderValue(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value.includes(" ") ? JSON.stringify(value) : value;
  if (value === null) return "null";
  if (Array.isArray(value) || typeof value === "object") {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  }
  return String(value);
}

function formatHuman(record: LogRecord, theme: ThemeName, colour: boolean): string {
  const time = localHms(record.time);
  const levelText = record.level.toUpperCase().padEnd(5);
  const nameText = record.name.padEnd(12);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record.fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  const fieldsText = parts.join(" ");
  const levelRendered = applyTheme(LEVEL_TOKENS[record.level], levelText, colour, theme);
  const nameRendered = applyTheme("fgName", nameText, colour, theme);
  const suffix = fieldsText.length > 0 ? ` ${fieldsText}` : "";
  return `${time} ${levelRendered} ${nameRendered} ${record.msg}${suffix}`;
}

function formatJsonPlain(record: LogRecord): string {
  const payload: Record<string, unknown> = {
    time: new Date(record.time).toISOString(),
    level: record.level,
    name: record.name,
    msg: record.msg,
  };
  for (const [key, value] of Object.entries(record.fields)) {
    payload[key] = value;
  }
  return JSON.stringify(payload) ?? "{}";
}

export function formatRecord(record: LogRecord, fmt: RecordFormat): string {
  if (fmt.json) return formatJsonPlain(record);
  return formatHuman(record, fmt.theme, fmt.colorEnabled);
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "info"];
  const json = options.json === true;
  const theme: ThemeName = options.theme ?? "dark";
  const env = options.env ?? { ...process.env };
  const sink = options.sink;
  const target = options.stream ?? process.stdout;
  const colourEnabled = json ? false : decideColour(target, options.color, env);

  const emit = (level: LogLevel, name: string, msg: string, fields: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    const record: LogRecord = { time: Date.now(), level, name, msg, fields };
    if (sink !== undefined) {
      sink(record);
      return;
    }
    target.write(`${formatRecord(record, { json, theme, colorEnabled: colourEnabled })}\n`);
  };

  const build = (name: string): Logger => ({
    debug: (msg, fields) => emit("debug", name, msg, fields ?? {}),
    info: (msg, fields) => emit("info", name, msg, fields ?? {}),
    warn: (msg, fields) => emit("warn", name, msg, fields ?? {}),
    error: (msg, fields) => emit("error", name, msg, fields ?? {}),
    child: (childName) => build(name === "" ? childName : `${name}.${childName}`),
  });
  return build("");
}
