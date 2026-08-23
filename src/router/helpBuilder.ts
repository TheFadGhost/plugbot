import type { CatalogCommand, CommandCatalog } from "./catalog.js";
import { argumentDocs, usageLine } from "./usage.js";

export const HELP_COMMAND = "help";

export interface HelpOptions {
  prefix?: string;
}

interface HelpNode {
  entry?: CatalogCommand;
  readonly children: Map<string, HelpNode>;
}

function childOf(parent: HelpNode, name: string): HelpNode {
  let child = parent.children.get(name);
  if (child === undefined) {
    child = { children: new Map() };
    parent.children.set(name, child);
  }
  return child;
}

function insert(root: HelpNode, entry: CatalogCommand): void {
  let node = root;
  for (const segment of entry.path) node = childOf(node, segment);
  if (node.entry === undefined) node.entry = entry;
}

function linkAliases(root: HelpNode, entry: CatalogCommand): void {
  const aliases = entry.aliases;
  if (aliases === undefined || aliases.length === 0 || entry.path.length === 0) return;
  let parent: HelpNode | undefined = root;
  for (const segment of entry.path.slice(0, -1)) {
    parent = parent.children.get(segment);
    if (parent === undefined) return;
  }
  const leaf = parent.children.get(entry.path[entry.path.length - 1]!);
  if (leaf === undefined) return;
  for (const alias of aliases) {
    if (!parent.children.has(alias)) parent.children.set(alias, leaf);
  }
}

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
    const root: HelpNode = { children: new Map() };
    for (const entry of groups.get(plugin)!) insert(root, entry);
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
  const lookup: HelpNode = { children: new Map() };
  for (const entry of visible) insert(lookup, entry);
  for (const entry of visible) linkAliases(lookup, entry);
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
