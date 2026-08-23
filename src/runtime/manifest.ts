/**
 * Serializable declaration mirror of a PluginSpec. Everything here is
 * structured-clone safe: no functions, no RegExp instances. See DESIGN.md
 * section 8 - declarations cross the worker boundary once at load.
 */

import type {
  ArgDef,
  ArgsSchema,
  CommandDef,
  JobDef,
  JobSchedule,
  ListenerDef,
  PluginConfigSchema,
  PluginSpec,
} from "../plugin/types.js";

export interface CommandManifest {
  path: string[];
  description: string;
  aliases?: string[];
  permission?: string;
  hidden?: boolean;
  args?: ArgsSchema;
}

export interface ListenerManifest {
  name: string;
  description?: string;
  patternSource?: string;
  patternFlags?: string;
  patternText?: string;
  cooldownMs?: number;
}

export interface JobManifest {
  name: string;
  description?: string;
  schedule: JobSchedule;
}

export type PluginIsolation = "thread" | "inline";

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  isolation: PluginIsolation;
  configSchema?: PluginConfigSchema;
  commands: CommandManifest[];
  listeners: ListenerManifest[];
  jobs: JobManifest[];
  events: Array<"message" | "memberJoin" | "memberLeave">;
  hasMiddleware: boolean;
}

const EVENT_KEYS = ["message", "memberJoin", "memberLeave"] as const;

function cloneArgs(args: ArgsSchema): ArgsSchema {
  const copy: Record<string, ArgDef> = {};
  for (const [key, def] of Object.entries(args)) {
    const field = { ...def };
    if (field.choices !== undefined) field.choices = [...field.choices];
    copy[key] = field;
  }
  return copy;
}

function collectCommands(
  commands: Readonly<Record<string, CommandDef<ArgsSchema>>>,
  prefix: readonly string[],
  out: CommandManifest[],
): void {
  for (const [key, def] of Object.entries(commands)) {
    const path = [...prefix, key];
    const entry: CommandManifest = { path, description: def.description };
    if (def.aliases !== undefined) entry.aliases = [...def.aliases];
    if (def.permission !== undefined) entry.permission = def.permission;
    if (def.hidden === true) entry.hidden = true;
    if (def.args !== undefined) entry.args = cloneArgs(def.args);
    out.push(entry);
    if (def.subcommands !== undefined) collectCommands(def.subcommands, path, out);
  }
}

function extractListenerManifest(listener: ListenerDef): ListenerManifest {
  const entry: ListenerManifest = { name: listener.name };
  if (listener.description !== undefined) entry.description = listener.description;
  if (listener.cooldownMs !== undefined) entry.cooldownMs = listener.cooldownMs;
  const pattern = listener.pattern;
  if (typeof pattern === "string") {
    entry.patternText = pattern;
  } else if (pattern instanceof RegExp) {
    entry.patternSource = pattern.source;
    entry.patternFlags = pattern.flags;
  }
  return entry;
}

function extractJobManifest(job: JobDef): JobManifest {
  const entry: JobManifest = { name: job.name, schedule: job.schedule };
  if (job.description !== undefined) entry.description = job.description;
  return entry;
}

export function extractManifest(spec: PluginSpec, fallbackIsolation: PluginIsolation): PluginManifest {
  const commands: CommandManifest[] = [];
  if (spec.commands !== undefined) collectCommands(spec.commands, [], commands);
  const listeners = (spec.listeners ?? []).map(extractListenerManifest);
  const jobs = (spec.jobs ?? []).map(extractJobManifest);
  const events: PluginManifest["events"] = [];
  for (const key of EVENT_KEYS) {
    if (spec.events?.[key] !== undefined) events.push(key);
  }
  const manifest: PluginManifest = {
    name: spec.name,
    isolation: spec.isolation ?? fallbackIsolation,
    commands,
    listeners,
    jobs,
    events,
    hasMiddleware: Array.isArray(spec.middleware) && spec.middleware.length > 0,
  };
  if (spec.version !== undefined) manifest.version = spec.version;
  if (spec.description !== undefined) manifest.description = spec.description;
  if (spec.configSchema !== undefined) manifest.configSchema = spec.configSchema;
  return manifest;
}

type ShapeCheck = { ok: true; spec: PluginSpec } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkCommandDef(value: unknown, where: string, problems: string[]): void {
  if (!isPlainObject(value)) {
    problems.push(`${where} must be an object`);
    return;
  }
  if (typeof value.run !== "function") problems.push(`${where}.run must be a function`);
  if (typeof value.description !== "string") problems.push(`${where}.description must be a string`);
  if (value.aliases !== undefined && !Array.isArray(value.aliases)) {
    problems.push(`${where}.aliases must be an array`);
  }
  if (value.args !== undefined && !isPlainObject(value.args)) {
    problems.push(`${where}.args must be an object`);
  }
  if (value.subcommands !== undefined) {
    if (!isPlainObject(value.subcommands)) {
      problems.push(`${where}.subcommands must be an object`);
      return;
    }
    for (const [key, sub] of Object.entries(value.subcommands)) {
      checkCommandDef(sub, `${where}.subcommands.${key}`, problems);
    }
  }
}

export function validateSpecShape(value: unknown): ShapeCheck {
  if (!isPlainObject(value)) return { ok: false, reason: "plugin default export must be an object" };
  const problems: string[] = [];
  if (typeof value.name !== "string" || value.name.length === 0) {
    return { ok: false, reason: "plugin spec requires a non-empty string \"name\"" };
  }
  if (value.version !== undefined && typeof value.version !== "string") {
    problems.push("version must be a string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    problems.push("description must be a string");
  }
  if (value.isolation !== undefined && value.isolation !== "thread" && value.isolation !== "inline") {
    problems.push("isolation must be \"thread\" or \"inline\"");
  }
  if (value.configSchema !== undefined && !isPlainObject(value.configSchema)) {
    problems.push("configSchema must be an object");
  }
  if (value.commands !== undefined) {
    if (!isPlainObject(value.commands)) {
      problems.push("commands must be an object");
    } else {
      for (const [key, cmd] of Object.entries(value.commands)) {
        checkCommandDef(cmd, `commands.${key}`, problems);
      }
    }
  }
  if (value.listeners !== undefined) {
    if (!Array.isArray(value.listeners)) {
      problems.push("listeners must be an array");
    } else {
      value.listeners.forEach((listener, i) => {
        if (!isPlainObject(listener)) {
          problems.push(`listeners[${i}] must be an object`);
          return;
        }
        if (typeof listener.name !== "string") problems.push(`listeners[${i}].name must be a string`);
        if (typeof listener.run !== "function") problems.push(`listeners[${i}].run must be a function`);
        const pattern = listener.pattern;
        if (pattern !== undefined && typeof pattern !== "string" && !(pattern instanceof RegExp)) {
          problems.push(`listeners[${i}].pattern must be a string or RegExp`);
        }
      });
    }
  }
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs)) {
      problems.push("jobs must be an array");
    } else {
      value.jobs.forEach((job, i) => {
        if (!isPlainObject(job)) {
          problems.push(`jobs[${i}] must be an object`);
          return;
        }
        if (typeof job.name !== "string") problems.push(`jobs[${i}].name must be a string`);
        const schedule = job.schedule as Record<string, unknown> | undefined;
        const everyOk = typeof schedule?.everyMs === "number";
        const dailyOk = typeof schedule?.dailyAt === "string";
        if (schedule === undefined || !isPlainObject(schedule) || (everyOk === dailyOk)) {
          problems.push(`jobs[${i}].schedule must be {everyMs:number} or {dailyAt:string}`);
        }
        if (typeof job.run !== "function") problems.push(`jobs[${i}].run must be a function`);
      });
    }
  }
  if (value.events !== undefined) {
    if (!isPlainObject(value.events)) {
      problems.push("events must be an object");
    } else {
      for (const key of EVENT_KEYS) {
        const hook = value.events[key];
        if (hook !== undefined && typeof hook !== "function") {
          problems.push(`events.${key} must be a function`);
        }
      }
    }
  }
  if (value.middleware !== undefined) {
    if (!Array.isArray(value.middleware) || value.middleware.some((m) => typeof m !== "function")) {
      problems.push("middleware must be an array of functions");
    }
  }
  if (value.init !== undefined && typeof value.init !== "function") problems.push("init must be a function");
  if (value.shutdown !== undefined && typeof value.shutdown !== "function") {
    problems.push("shutdown must be a function");
  }
  if (problems.length > 0) return { ok: false, reason: problems.join("; ") };
  return { ok: true, spec: value as unknown as PluginSpec };
}
