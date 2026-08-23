export interface ParsedArgv {
  command: string | null;
  flags: Record<string, string | boolean>;
  positionals: string[];
  errors: string[];
}

interface FlagSpec {
  readonly value: boolean;
}

const FLAG_SPECS: Readonly<Record<string, FlagSpec>> = {
  "--config": { value: true },
  "--no-color": { value: false },
  "--log-json": { value: false },
  "--version": { value: false },
  "-h": { value: false },
  "--help": { value: false },
  "--dir": { value: true },
  "--out": { value: true },
  "--adapter": { value: true },
  "--log-level": { value: true },
};

const VALUE_FLAGS = new Set(["--config", "--dir", "--out", "--adapter", "--log-level"]);

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const errors: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("-") || token === "-") {
      if (command === null) command = token;
      else positionals.push(token);
      continue;
    }
    const equalsAt = token.indexOf("=");
    const bareName = equalsAt > 0 ? token.slice(0, equalsAt) : token;
    const spec = FLAG_SPECS[bareName];
    if (spec === undefined) {
      errors.push(`unknown flag "${bareName}"`);
      continue;
    }
    if (VALUE_FLAGS.has(bareName)) {
      if (equalsAt > 0) {
        flags[bareName] = token.slice(equalsAt + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) {
        errors.push(`flag "${bareName}" requires a value`);
        continue;
      }
      flags[bareName] = next;
      i++;
      continue;
    }
    flags[bareName] = true;
  }

  return { command, flags, positionals, errors };
}
