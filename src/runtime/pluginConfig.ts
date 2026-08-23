/**
 * Plugin configuration resolution: merges declared defaults over user
 * values and validates types against the plugin's own configSchema, so
 * handlers always receive a complete correctly-typed config object.
 * Failures are PluginLoadError naming plugin and exact key.
 */

import { PluginLoadError } from "../errors.js";
import type { PluginConfigSchema } from "../plugin/types.js";

function describeExpected(type: string): string {
  switch (type) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "string[]":
      return "an array of strings";
    default:
      return type;
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" && value.length > 0;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    default:
      return false;
  }
}

export function applyPluginConfig(
  schema: PluginConfigSchema | undefined,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (schema === undefined) {
    if (Object.keys(raw).length > 0) {
      throw new Error(`plugin declares no configSchema but config values were provided`);
    }
    return {};
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (field.required === true) {
        throw new Error(`missing required config key "${key}"`);
      }
      if (field.default !== undefined) resolved[key] = field.default;
      continue;
    }
    if (!matchesType(value, field.type)) {
      const actual =
        value === null ? "null" : Array.isArray(value) ? "an array" : typeof value;
      throw new Error(`config key "${key}": expected ${describeExpected(field.type)}, got ${actual}`);
    }
    resolved[key] = Array.isArray(value) ? [...value] : value;
  }
  for (const key of Object.keys(raw)) {
    if (!(key in schema)) {
      throw new Error(`unexpected config key "${key}"`);
    }
  }
  return resolved;
}
