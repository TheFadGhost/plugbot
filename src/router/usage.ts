import type { ArgDef, ArgsSchema } from "../plugin/types.js";

export function usageLine(path: readonly string[], args: ArgsSchema | undefined): string {
  const segments = [...path];
  if (args) {
    for (const [key, def] of Object.entries(args)) {
      segments.push(placeholder(key, def));
    }
  }
  return segments.join(" ");
}

function placeholder(key: string, def: ArgDef): string {
  if (def.rest === true) return `[${key}...]`;
  if (def.required === true) return `<${key}>`;
  return `[${key}]`;
}

export function argumentDocs(args: ArgsSchema | undefined): readonly string[] {
  if (!args) return [];
  const lines: string[] = [];
  for (const [key, def] of Object.entries(args)) {
    const flags: string[] = [def.rest === true ? `${def.type}...` : def.type];
    if (def.required === true) flags.push("required");
    if (def.default !== undefined) flags.push(`default ${JSON.stringify(def.default)}`);
    if (def.choices && def.choices.length > 0) {
      flags.push(`one of: ${def.choices.map((choice) => String(choice)).join("|")}`);
    }
    if (def.min !== undefined) flags.push(`minimum ${String(def.min)}`);
    if (def.max !== undefined) flags.push(`maximum ${String(def.max)}`);
    const head = `${key} (${flags.join(", ")})`;
    lines.push(def.description === undefined ? head : `${head} ${def.description}`);
  }
  return lines;
}
