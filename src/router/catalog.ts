import type { ArgsSchema } from "../plugin/types.js";

export interface CatalogCommand {
  plugin: string;
  path: readonly string[];
  description: string;
  aliases?: readonly string[];
  args?: ArgsSchema;
  permission?: string;
  hidden?: boolean;
  /** False marks a bare group that only routes to subcommands. */
  runnable?: boolean;
}

export interface CommandCatalog {
  commands(): readonly CatalogCommand[];
}

export function catalogFromEntries(entries: readonly CatalogCommand[]): CommandCatalog {
  return {
    commands: () => entries,
  };
}
