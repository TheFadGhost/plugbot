import type { CatalogCommand, CommandCatalog } from "../router/catalog.js";
import { argumentDocs, usageLine } from "../router/usage.js";

export interface MarkdownDocsOptions {
  title: string;
  prefix?: string;
}

interface DocsNode {
  entry?: CatalogCommand;
  readonly children: Map<string, DocsNode>;
}

function docsChild(parent: DocsNode, name: string): DocsNode {
  let child = parent.children.get(name);
  if (child === undefined) {
    child = { children: new Map() };
    parent.children.set(name, child);
  }
  return child;
}

function insertDocs(root: DocsNode, entry: CatalogCommand): void {
  let node = root;
  for (const segment of entry.path) node = docsChild(node, segment);
  if (node.entry === undefined) node.entry = entry;
}

function renderDocsNode(node: DocsNode, level: number, prefix: string, lines: string[]): void {
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
    const root: DocsNode = { children: new Map() };
    for (const entry of groups.get(plugin)!) insertDocs(root, entry);
    renderDocsNode(root, 3, prefix, lines);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
