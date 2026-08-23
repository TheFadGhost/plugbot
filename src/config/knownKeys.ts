/**
 * Machine-readable description of the configuration schema. Drives validation
 * in config/loader.ts and edit-distance suggestions for unknown keys.
 */

import { LOG_LEVELS } from "../logging/types.js";

export type ConfigKeyType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "string[]"
  | "object";

export interface ConfigKeyDescription {
  readonly type: ConfigKeyType;
  readonly enumValues?: readonly string[];
  /** Numbers only: value must be finite and > 0. */
  readonly positive?: boolean;
  /** Strings only: value must not be "". */
  readonly nonEmpty?: boolean;
}

const ADAPTER_TYPES: readonly string[] = ["mock", "transcript", "irc"];
const ISOLATION_MODES: readonly string[] = ["thread", "inline"];
const LOG_THEMES: readonly string[] = ["dark", "light"];

export const CONFIG_SCHEMA: Readonly<
  Record<string, Readonly<Record<string, ConfigKeyDescription>>>
> = {
  adapter: {
    type: { type: "enum", enumValues: ADAPTER_TYPES },
    options: { type: "object" },
  },
  bot: {
    username: { type: "string" },
  },
  plugins: {
    dir: { type: "string", nonEmpty: true },
    disabled: { type: "string[]" },
    isolation: { type: "enum", enumValues: ISOLATION_MODES },
  },
  commands: {
    prefix: { type: "string", nonEmpty: true },
    mentionAliases: { type: "string[]" },
  },
  permissions: {
    adminUserIds: { type: "string[]" },
    denyByDefaultAdmin: { type: "boolean" },
  },
  storage: {
    file: { type: "string", nonEmpty: true },
  },
  logging: {
    level: { type: "enum", enumValues: LOG_LEVELS },
    json: { type: "boolean" },
    theme: { type: "enum", enumValues: LOG_THEMES },
  },
  limits: {
    handlerTimeoutMs: { type: "number", positive: true },
    breakerThreshold: { type: "number", positive: true },
    breakerWindowMs: { type: "number", positive: true },
    breakerCooldownMs: { type: "number", positive: true },
    userCommandsPerMinute: { type: "number", positive: true },
    shutdownDrainMs: { type: "number", positive: true },
  },
  pluginConfigs: {},
};

export const KNOWN_SECTIONS: readonly string[] = Object.keys(CONFIG_SCHEMA);

/** Case-insensitive lookup of a key inside a section; canonical otherwise. */
export function describeKey(section: string, key: string): ConfigKeyDescription | undefined {
  const keys = CONFIG_SCHEMA[section.toLowerCase()];
  if (keys === undefined) return undefined;
  const lowered = key.toLowerCase();
  const canonical = Object.keys(keys).find((k) => k.toLowerCase() === lowered);
  return canonical === undefined ? undefined : keys[canonical];
}

export function allKnownKeyPaths(): string[] {
  const paths: string[] = [];
  for (const section of KNOWN_SECTIONS) {
    const keys = CONFIG_SCHEMA[section];
    if (keys === undefined) continue;
    for (const key of Object.keys(keys)) paths.push(`${section}.${key}`);
  }
  return paths;
}
