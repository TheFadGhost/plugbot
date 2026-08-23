import type { CatalogCommand, CommandCatalog, CommandTrieNode } from "../router/catalog.js";
import { buildCommandTrie } from "../router/catalog.js";
import { argumentDocs, usageLine } from "../router/usage.js";

export interface MarkdownDocsOptions {
  title: string;
  prefix?: string;
}

function renderDocsNode(node: CommandTrieNode, level: number, prefix: string, lines: string[]): void {
  for (const child of node.children.values()) {
    const entry = child.entry;
    if (entry === undefined) continue;
    const hashes = "#".repeat(Math.min(level, 6));
    lines.push(`${hashes} ${entry.path.join(" ")}`, "", entry.description, "");
    lines.push("Usage:", "", "```", `${prefix}${usageLine(entry.path, entry.args)}`, "```", "");
    const docs = argumentDocs(entry.args);
    if (docs.length > 0) {
      lines.push("Arguments:", "");
      for (const doc of docs) lines.push(`- ${doc}`);
      lines.push("");
    }
    if (entry.aliases !== undefined && entry.aliases.length > 0) {
      lines.push(`Aliases: ${entry.aliases.join(", ")}`, "");
    }
    renderDocsNode(child, level + 1, prefix, lines);
  }
}

export function generateMarkdownDocs(catalog: CommandCatalog, opts: MarkdownDocsOptions): string {
  const prefix = opts.prefix ?? "!";
  const visible = catalog.commands().filter((entry) => entry.hidden !== true);
  const groups = new Map<string, CatalogCommand[]>();
  for (const entry of visible) {
    const group = groups.get(entry.plugin);
    if (group === undefined) groups.set(entry.plugin, [entry]);
    else group.push(entry);
  }
  const lines: string[] = [`# ${opts.title}`, ""];
  for (const plugin of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push(`## ${plugin}`, "");
    const root = buildCommandTrie(groups.get(plugin)!);
    renderDocsNode(root, 3, prefix, lines);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
