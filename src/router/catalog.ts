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

/** The one shared command trie; router, help, and docs all consume this shape. */
export interface CommandTrieNode {
  entry?: CatalogCommand;
  readonly children: Map<string, CommandTrieNode>;
}

export function trieChild(parent: CommandTrieNode, name: string): CommandTrieNode {
  let child = parent.children.get(name);
  if (child === undefined) {
    child = { children: new Map() };
    parent.children.set(name, child);
  }
  return child;
}

export function insertCommandEntry(root: CommandTrieNode, entry: CatalogCommand): void {
  let node = root;
  for (const segment of entry.path) node = trieChild(node, segment);
  if (node.entry === undefined) node.entry = entry;
}

/** Alias tokens attach at the parent of the final path segment and share the canonical node. */
export function linkCommandAliases(root: CommandTrieNode, entries: readonly CatalogCommand[]): void {
  for (const entry of entries) {
    const aliases = entry.aliases;
    if (aliases === undefined || aliases.length === 0 || entry.path.length === 0) continue;
    let parent: CommandTrieNode | undefined = root;
    for (const segment of entry.path.slice(0, -1)) {
      parent = parent.children.get(segment);
      if (parent === undefined) break;
    }
    if (parent === undefined) continue;
    const leaf = parent.children.get(entry.path[entry.path.length - 1]!);
    if (leaf === undefined) continue;
    for (const alias of aliases) {
      if (!parent.children.has(alias)) parent.children.set(alias, leaf);
    }
  }
}

export function buildCommandTrie(entries: readonly CatalogCommand[]): CommandTrieNode {
  const root: CommandTrieNode = { children: new Map() };
  for (const entry of entries) {
    if (entry.path.length === 0) continue;
    insertCommandEntry(root, entry);
  }
  linkCommandAliases(root, entries);
  return root;
}
