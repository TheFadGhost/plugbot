import type { ArgDef, ArgsSchema } from "../plugin/types.js";

export interface ParseOutcome {
  args: Record<string, unknown>;
  problems: string[];
}

type Coerced = { ok: true; value: string | number | boolean } | { ok: false; problems: string[] };

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  true: true,
  yes: true,
  on: true,
  false: false,
  no: false,
  off: false,
};
export function parseArguments(schema: ArgsSchema | undefined, tokens: readonly string[]): ParseOutcome {
  if (schema === undefined) {
    return { args: {}, problems: tokens.map((token) => `unexpected argument "${token}"`) };
  }
  const entries = Object.entries(schema);
  const restIndex = entries.findIndex(([, def]) => def.rest === true);
  if (restIndex >= 0 && restIndex < entries.length - 1) {
    return { args: {}, problems: ["rest argument must be last"] };
  }
  const problems: string[] = [];
  const args: Record<string, unknown> = {};
  let cursor = 0;
  for (const [key, def] of entries) {
    if (def.rest === true) {
      const rest = tokens.slice(cursor);
      cursor = tokens.length;
      if (rest.length === 0 && def.required === true) {
        problems.push(`missing required argument ${key}`);
      }
      args[key] = rest;
      continue;
    }
    const token = cursor < tokens.length ? tokens[cursor] : undefined;
    if (token === undefined) {
      if (def.required === true) problems.push(`missing required argument ${key}`);
      else if (def.default !== undefined) args[key] = defaultValue(def);
      continue;
    }
    cursor += 1;
    const outcome = coerce(key, def, token);
    if (outcome.ok) args[key] = outcome.value;
    else problems.push(...outcome.problems);
  }
  while (cursor < tokens.length) {
    problems.push(`unexpected argument "${tokens[cursor]!}"`);
    cursor += 1;
  }
  return { args, problems };
}

function defaultValue(def: ArgDef): string | number | boolean {
  const raw = def.default!;
  const converted = convert(def.type, String(raw));
  return converted.ok ? converted.value : raw;
}

type Converted = { ok: true; value: string | number | boolean } | { ok: false };

function convert(type: ArgDef["type"], token: string): Converted {
  if (type === "number") {
    if (token === "" || !Number.isFinite(Number(token))) return { ok: false };
    return { ok: true, value: Number(token) };
  }
  if (type === "duration") {
    const match = DURATION_PATTERN.exec(token);
    if (match === null || match[2] === undefined) return { ok: false };
    return { ok: true, value: Number.parseFloat(match[1]!) * DURATION_UNIT_MS[match[2].toLowerCase()]! };
  }
  if (type === "boolean") {
    const parsed = BOOLEAN_VALUES[token.toLowerCase()];
    if (parsed === undefined) return { ok: false };
    return { ok: true, value: parsed };
  }
  return { ok: true, value: token };
}

function coerce(key: string, def: ArgDef, token: string): Coerced {
  const converted = convert(def.type, token);
  if (!converted.ok) {
    return { ok: false, problems: [invalidMessage(def.type, key, token)] };
  }
  const failure = validateConstraints(key, def, token, converted.value);
  if (failure.length > 0) return { ok: false, problems: failure };
  return { ok: true, value: converted.value };
}

function invalidMessage(type: ArgDef["type"], key: string, token: string): string {
  if (type === "duration") return `invalid duration "${token}" for ${key}, like "90s" or "5m"`;
  if (type === "boolean") return `invalid boolean "${token}" for ${key}`;
  if (type === "number") return `invalid number "${token}" for ${key}`;
  return `invalid string "${token}" for ${key}`;
}

function validateConstraints(
  key: string,
  def: ArgDef,
  token: string,
  value: string | number | boolean,
): string[] {
  const problems: string[] = [];
  if (def.choices !== undefined && def.choices.length > 0) {
    const allowed = def.choices.some((choice) => String(choice) === String(value));
    if (!allowed) {
      problems.push(`value "${token}" for ${key} must be one of: ${def.choices.map((choice) => String(choice)).join("|")}`);
    }
  }
  if (typeof value === "number") {
    if (def.min !== undefined && value < def.min) {
      problems.push(`value ${String(value)} for ${key} must be at least ${String(def.min)}`);
    }
    if (def.max !== undefined && value > def.max) {
      problems.push(`value ${String(value)} for ${key} must be at most ${String(def.max)}`);
    }
  }
  return problems;
}
