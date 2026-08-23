import { readFile as readFsFile } from "node:fs/promises";

import { ConfigError, type ConfigViolation } from "../errors.js";
import {
  CONFIG_SCHEMA,
  KNOWN_SECTIONS,
  allKnownKeyPaths,
  describeKey,
  type ConfigKeyDescription,
} from "./knownKeys.js";
import { expectedOneOf, renderActualValue, renderViolations } from "./render.js";
import {
  CONFIG_ENV_PREFIX,
  CONFIG_ENV_SEPARATOR,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  type PlugbotConfig,
} from "./types.js";

export interface LoadConfigOptions {
  file?: string;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<string>;
}

export interface LoadedConfig {
  config: PlugbotConfig;
  loadedFromFile: string | null;
}

interface CoercionOk {
  readonly ok: true;
  readonly value: unknown;
}

interface CoercionFail {
  readonly ok: false;
  readonly expectation: string;
  readonly actual: string;
}

const ENV_ALIASES: Readonly<Record<string, string>> = {
  PLUGBOT_LOG_JSON: "logging.json",
  PLUGBOT_THEME: "logging.theme",
};

const ENV_BOOLEAN_TRUE = new Set(["true", "1", "yes"]);
const ENV_BOOLEAN_FALSE = new Set(["false", "0", "no"]);
const MAX_SUGGESTION_DISTANCE = 2;

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const explicitFile = opts.file !== undefined;
  const chosenFile = opts.file ?? DEFAULT_CONFIG_FILE;
  const read = opts.readFile ?? ((path: string) => readFsFile(path, "utf8"));
  const env = opts.env ?? { ...process.env };

  const merged: PlugbotConfig = structuredClone(DEFAULT_CONFIG);
  const view = merged as unknown as Record<string, Record<string, unknown>>;
  const provenance = new Map<string, string>();
  const violations: ConfigViolation[] = [];

  let loadedFromFile: string | null = null;
  let fileText: string | null = null;

  try {
    fileText = await read(chosenFile);
    loadedFromFile = chosenFile;
  } catch (err) {
    if (!isEnoent(err)) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`cannot read config file ${chosenFile}: ${reason}`, { source: chosenFile });
    }
    if (explicitFile) {
      throw new ConfigError(`config file not found: ${chosenFile}`, { source: chosenFile });
    }
  }

  if (fileText !== null) {
    const parsed = parseJsonFile(fileText, chosenFile);
    if (!isPlainObject(parsed)) {
      throw new ConfigError(`config file must contain a JSON object: ${chosenFile}`, { source: chosenFile });
    }
    mergeFileSection(parsed, chosenFile, view, provenance, violations);
  }

  applyEnvOverrides(env, view, provenance, violations);

  const fallbackSource = loadedFromFile ?? "env";
  validateMerged(view, provenance, fallbackSource, violations);

  if (violations.length > 0) {
    throw new ConfigError(renderViolations(violations).join("\n"), {
      violations: [...violations],
      source: fallbackSource,
    });
  }

  return { config: merged, loadedFromFile };
}

function isEnoent(err: unknown): boolean {
  return (err as Partial<NodeJS.ErrnoException> | undefined)?.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonFile(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`invalid JSON in ${path}: ${reason}${offsetSnippet(text, reason)}`, { source: path });
  }
}

function offsetSnippet(text: string, reason: string): string {
  const match = /position (\d+)/.exec(reason);
  const rawOffset = match?.[1];
  if (rawOffset === undefined) return "";
  const offset = Number(rawOffset);
  if (!Number.isFinite(offset)) return "";
  const start = Math.max(0, offset - 20);
  const end = Math.min(text.length, offset + 20);
  const near = text.slice(start, end).replace(/\s+/g, " ");
  return `\n  near: ${near}`;
}

type Provenance = Map<string, string>;

function mergeFileSection(
  root: Record<string, unknown>,
  source: string,
  view: Record<string, Record<string, unknown>>,
  provenance: Provenance,
  violations: ConfigViolation[],
): void {
  const knownPaths = allKnownKeyPaths();
  for (const section of Object.keys(root)) {
    const value = root[section];
    if (!Object.hasOwn(CONFIG_SCHEMA, section)) {
      collectUnknownFileEntry(section, value, knownPaths, source, violations);
      continue;
    }
    if (!isPlainObject(value)) {
      violations.push({
        key: section,
        expectation: "expected an object",
        actual: renderActualValue(value),
        source,
      });
      continue;
    }
    const sectionView = view[section];
    if (sectionView === undefined) continue;
    if (Object.keys(CONFIG_SCHEMA[section] ?? {}).length === 0) {
      mergeFreeFormSection(section, value, source, sectionView, provenance, violations);
      continue;
    }
    for (const key of Object.keys(value)) {
      const path = `${section}.${key}`;
      const desc = describeKey(section, key);
      if (desc === undefined) {
        violations.push({
          key: path,
          expectation: "unknown key",
          actual: nearestMatch(knownPaths, path) ?? "",
          source,
        });
        continue;
      }
      const keyValue = value[key];
      if (keyValue === null) {
        violations.push({ key: path, expectation: "missing required key", actual: "", source });
        continue;
      }
      if (desc.type === "object" && !isPlainObject(keyValue)) {
        violations.push({
          key: path,
          expectation: "expected an object",
          actual: renderActualValue(keyValue),
          source,
        });
        continue;
      }
      sectionView[key] = keyValue;
      provenance.set(path, source);
    }
  }
}

function mergeFreeFormSection(
  section: string,
  value: Record<string, unknown>,
  source: string,
  sectionView: Record<string, unknown>,
  provenance: Provenance,
  violations: ConfigViolation[],
): void {
  for (const key of Object.keys(value)) {
    const keyValue = value[key];
    const path = `${section}.${key}`;
    if (!isPlainObject(keyValue)) {
      violations.push({
        key: path,
        expectation: "expected an object",
        actual: renderActualValue(keyValue),
        source,
      });
      continue;
    }
    sectionView[key] = keyValue;
    provenance.set(path, source);
  }
}

function collectUnknownFileEntry(
  section: string,
  value: unknown,
  knownPaths: readonly string[],
  source: string,
  violations: ConfigViolation[],
): void {
  if (isPlainObject(value)) {
    const subKeys = Object.keys(value);
    if (subKeys.length === 0) {
      violations.push({
        key: section,
        expectation: "unknown key",
        actual: nearestMatch(knownPaths, section) ?? "",
        source,
      });
      return;
    }
    for (const subKey of subKeys) {
      const path = `${section}.${subKey}`;
      violations.push({
        key: path,
        expectation: "unknown key",
        actual: nearestMatch(knownPaths, path) ?? "",
        source,
      });
    }
    return;
  }
  violations.push({
    key: section,
    expectation: "unknown key",
    actual: nearestMatch(knownPaths, section) ?? "",
    source,
  });
}

function applyEnvOverrides(
  env: Record<string, string | undefined>,
  view: Record<string, Record<string, unknown>>,
  provenance: Provenance,
  violations: ConfigViolation[],
): void {
  for (const name of Object.keys(env)) {
    const raw = env[name];
    if (raw === undefined || !name.startsWith(CONFIG_ENV_PREFIX)) continue;

    const aliasTarget = ENV_ALIASES[name.toUpperCase()];
    if (aliasTarget !== undefined) {
      applyNamedOverride(aliasTarget, raw, name, view, provenance, violations);
      continue;
    }

    const parts = name.slice(CONFIG_ENV_PREFIX.length).split(CONFIG_ENV_SEPARATOR).filter((p) => p !== "");
    const sectionPart = parts[0];
    const keyPart = parts[1];
    if (parts.length !== 2 || sectionPart === undefined || keyPart === undefined) {
      pushUnknownEnvViolation(name, parts, violations);
      continue;
    }
    const section = KNOWN_SECTIONS.find((s) => s.toUpperCase() === sectionPart.toUpperCase());
    if (section === undefined) {
      pushUnknownEnvViolation(name, parts, violations);
      continue;
    }
    const keys = CONFIG_SCHEMA[section];
    if (keys === undefined) {
      pushUnknownEnvViolation(name, parts, violations);
      continue;
    }
    const key = Object.keys(keys).find((k) => k.toLowerCase() === keyPart.toLowerCase());
    if (key === undefined) {
      violations.push({
        key: `${section}.${keyPart.toLowerCase()}`,
        expectation: "unknown key",
        actual: nearestEnvPath(name) ?? "",
        source: name,
      });
      continue;
    }
    applyEnvKey(section, key, raw, name, view, provenance, violations);
  }
}

function pushUnknownEnvViolation(
  envName: string,
  parts: readonly string[],
  violations: ConfigViolation[],
): void {
  violations.push({
    key: parts.map((part) => part.toLowerCase()).join("."),
    expectation: "unknown key",
    actual: nearestEnvPath(envName) ?? "",
    source: envName,
  });
}

function applyNamedOverride(
  dotPath: string,
  raw: string,
  envName: string,
  view: Record<string, Record<string, unknown>>,
  provenance: Provenance,
  violations: ConfigViolation[],
): void {
  const separatorAt = dotPath.indexOf(".");
  if (separatorAt < 0) return;
  applyEnvKey(dotPath.slice(0, separatorAt), dotPath.slice(separatorAt + 1), raw, envName, view, provenance, violations);
}

function applyEnvKey(
  section: string,
  key: string,
  raw: string,
  envName: string,
  view: Record<string, Record<string, unknown>>,
  provenance: Provenance,
  violations: ConfigViolation[],
): void {
  const path = `${section}.${key}`;
  const desc = describeKey(section, key);
  const sectionView = view[section];
  if (desc === undefined || sectionView === undefined) return;

  if (desc.type === "object") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      violations.push({ key: path, expectation: "valid JSON object", actual: renderActualValue(raw), source: envName });
      return;
    }
    if (!isPlainObject(parsed)) {
      violations.push({ key: path, expectation: "valid JSON object", actual: renderActualValue(parsed), source: envName });
      return;
    }
    sectionView[key] = parsed;
    provenance.set(path, envName);
    return;
  }

  const coerced = coerceScalar(raw, desc);
  if (!coerced.ok) {
    violations.push({ key: path, expectation: coerced.expectation, actual: coerced.actual, source: envName });
    return;
  }
  sectionView[key] = coerced.value;
  provenance.set(path, envName);
}

function coerceScalar(raw: string, desc: ConfigKeyDescription): CoercionOk | CoercionFail {
  switch (desc.type) {
    case "number": {
      const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(parsed)) {
        return { ok: false, expectation: "expected a number", actual: renderActualValue(raw) };
      }
      if (desc.positive === true && parsed <= 0) {
        return { ok: false, expectation: "expected a positive number", actual: renderActualValue(raw) };
      }
      return { ok: true, value: parsed };
    }
    case "boolean": {
      const lowered = raw.trim().toLowerCase();
      if (ENV_BOOLEAN_TRUE.has(lowered)) return { ok: true, value: true };
      if (ENV_BOOLEAN_FALSE.has(lowered)) return { ok: true, value: false };
      return { ok: false, expectation: "expected a boolean", actual: renderActualValue(raw) };
    }
    case "string":
      return { ok: true, value: raw };
    case "string[]":
      return {
        ok: true,
        value: raw.split(",").map((part) => part.trim()).filter((part) => part !== ""),
      };
    case "enum": {
      const values = desc.enumValues ?? [];
      if (values.includes(raw)) return { ok: true, value: raw };
      return { ok: false, expectation: expectedOneOf(values), actual: renderActualValue(raw) };
    }
    case "object":
      return { ok: true, value: raw };
  }
}

function validateMerged(
  view: Record<string, Record<string, unknown>>,
  provenance: Provenance,
  fallbackSource: string,
  violations: ConfigViolation[],
): void {
  for (const section of KNOWN_SECTIONS) {
    const keys = CONFIG_SCHEMA[section];
    const sectionView = view[section];
    if (keys === undefined || sectionView === undefined) continue;
    for (const key of Object.keys(keys)) {
      const desc = keys[key];
      if (desc === undefined) continue;
      const path = `${section}.${key}`;
      const value = sectionView[key];
      const problem = describeProblem(value, desc);
      if (problem === undefined) continue;
      violations.push({
        key: path,
        expectation: problem,
        actual: problem === "missing required key" ? "" : renderActualValue(value),
        source: provenance.get(path) ?? fallbackSource,
      });
    }
  }
}

function describeProblem(value: unknown, desc: ConfigKeyDescription): string | undefined {
  if (value === undefined || value === null) return "missing required key";
  switch (desc.type) {
    case "string":
      if (typeof value !== "string") return "expected a string";
      if (desc.nonEmpty === true && value === "") return "expected a non-empty string";
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "expected a number";
      if (desc.positive === true && value <= 0) return "expected a positive number";
      return undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected a boolean";
    case "enum": {
      const values = desc.enumValues ?? [];
      return typeof value === "string" && values.includes(value)
        ? undefined
        : expectedOneOf(values);
    }
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? undefined
        : "expected an array of strings";
    case "object":
      return isPlainObject(value) ? undefined : "expected an object";
  }
}

function editDistance(a: string, b: string): number {
  const row: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      const left = row[j - 1] ?? 0;
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, left + 1, diagonal + substitutionCost);
      diagonal = above;
    }
  }
  return row[b.length] ?? Number.MAX_SAFE_INTEGER;
}

function nearestMatch(candidates: readonly string[], target: string): string | undefined {
  const sorted = [...candidates].sort();
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const candidate of sorted) {
    const distance = editDistance(target, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

function nearestEnvPath(envName: string): string | undefined {
  const pairs: Array<[form: string, path: string]> = allKnownKeyPaths().map((path) => [
    `${CONFIG_ENV_PREFIX}${path.replace(".", CONFIG_ENV_SEPARATOR)}`.toUpperCase(),
    path,
  ]);
  for (const aliasForm of Object.keys(ENV_ALIASES)) {
    const aliasPath = ENV_ALIASES[aliasForm];
    if (aliasPath !== undefined) pairs.push([aliasForm, aliasPath]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const target = envName.toUpperCase();
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const [form, path] of pairs) {
    const distance = editDistance(target, form);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = path;
    }
  }
  return best;
}
