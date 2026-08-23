import type { CatalogCommand, CommandCatalog, CommandTrieNode } from "./catalog.js";
import { buildCommandTrie } from "./catalog.js";
import { argumentDocs, usageLine } from "./usage.js";

export const HELP_COMMAND = "help";

export interface HelpOptions {
  prefix?: string;
}

type HelpNode = CommandTrieNode;

function isVisible(node: HelpNode): boolean {
  return node.entry !== undefined && node.entry.hidden !== true;
}

function sortedChildren(node: HelpNode): HelpNode[] {
  return [...node.children.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => node.children.get(name)!);
}

function groupByPlugin(entries: readonly CatalogCommand[]): Map<string, CatalogCommand[]> {
  const groups = new Map<string, CatalogCommand[]>();
  for (const entry of entries) {
    const group = groups.get(entry.plugin);
    if (group === undefined) groups.set(entry.plugin, [entry]);
    else group.push(entry);
  }
  return groups;
}

function renderOverview(node: HelpNode, depth: number, lines: string[]): void {
  for (const child of sortedChildren(node)) {
    if (!isVisible(child)) {
      renderOverview(child, depth, lines);
      continue;
    }
    const entry = child.entry!;
    lines.push(`${"  ".repeat(depth)}${entry.path.join(" ")} - ${entry.description}`);
    renderOverview(child, depth + 1, lines);
  }
}

export function buildHelpOverview(catalog: CommandCatalog, options: HelpOptions = {}): string[] {
  const prefix = options.prefix ?? "!";
  const visible = catalog.commands().filter((entry) => entry.hidden !== true);
  const lines: string[] = ["Commands:"];
  const groups = groupByPlugin(visible);
  for (const plugin of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const root: HelpNode = buildCommandTrie(groups.get(plugin)!);
    renderOverview(root, 1, lines);
  }
  lines.push(`Run "${prefix}help <command>" for details.`);
  return lines;
}

export function buildHelpDetail(
  catalog: CommandCatalog,
  pathTokens: readonly string[],
  options: HelpOptions = {},
): string[] | null {
  const prefix = options.prefix ?? "!";
  const visible = catalog.commands().filter((entry) => entry.hidden !== true);
  const lookup: HelpNode = buildCommandTrie(visible);
  let node: HelpNode | undefined = lookup;
  for (const token of pathTokens) {
    node = node.children.get(token);
    if (node === undefined) return null;
  }
  if (node.entry === undefined || node.entry.hidden === true) return null;
  const entry = node.entry;
  const fullPath = entry.path.join(" ");
  const lines: string[] = [`${fullPath} - ${entry.description}`];
  lines.push(`Usage: ${prefix}${usageLine(entry.path, entry.args)}`);
  const docs = argumentDocs(entry.args);
  if (docs.length > 0) {
    lines.push("Arguments:");
    for (const doc of docs) lines.push(`  ${doc}`);
  }
  if (entry.aliases !== undefined && entry.aliases.length > 0) {
    lines.push(`Aliases: ${entry.aliases.join(", ")}`);
  }
  const kids = sortedChildren(node).filter(isVisible);
  if (kids.length > 0) {
    lines.push("Subcommands:");
    for (const kid of kids) {
      const kidEntry = kid.entry!;
      lines.push(`  ${kidEntry.path.join(" ")} - ${kidEntry.description}`);
    }
  }
  return lines;
}
