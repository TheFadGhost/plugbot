import { describe, expect, it } from "vitest";
import { generateMarkdownDocs } from "../src/cli/docsGen.js";
import type { CatalogCommand } from "../src/router/catalog.js";
import { catalogFromEntries } from "../src/router/catalog.js";
import { buildHelpDetail, buildHelpOverview } from "../src/router/helpBuilder.js";
import { argumentDocs, usageLine } from "../src/router/usage.js";

const FIXTURE_ENTRIES: CatalogCommand[] = [
  {
    plugin: "zeta",
    path: ["zebra"],
    description: "Zebra stripes.",
  },
  {
    plugin: "alpha",
    path: ["note"],
    description: "Manage notes.",
    args: {
      body: { type: "string", rest: true, required: true, description: "Note text." },
    },
  },
  {
    plugin: "alpha",
    path: ["note", "add"],
    description: "Add a note.",
    aliases: ["a"],
  },
  {
    plugin: "alpha",
    path: ["note", "add", "undo"],
    description: "Undo the last note.",
  },
  {
    plugin: "alpha",
    path: ["banana"],
    description: "Split a banana.",
  },
  {
    plugin: "alpha",
    path: ["apple"],
    description: "Peel an apple.",
  },
  {
    plugin: "deploy",
    path: ["deploy"],
    description: "Ship it.",
    aliases: ["ship"],
    args: {
      env: { type: "string", required: true, choices: ["dev", "prod"], description: "Target environment" },
      timeout: { type: "duration", default: "30s", description: "Rollout timeout" },
      replicas: { type: "number", min: 1, max: 10, description: "Replica count" },
      verbose: { type: "boolean", description: "Chatty output" },
      tags: { type: "string", rest: true, description: "Extra tags" },
    },
  },
  {
    plugin: "secret",
    path: ["backdoor"],
    description: "Hidden thing.",
    hidden: true,
  },
];

describe("usageLine", () => {
  it("renders required, optional, and rest placeholders", () => {
    expect(
      usageLine(["poll", "create"], {
        title: { type: "string", required: true },
        duration: { type: "duration" },
      }),
    ).toBe("poll create <title> [duration]");
    expect(usageLine(["note"], { body: { type: "string", rest: true, required: true } })).toBe(
      "note [body...]",
    );
    expect(usageLine(["ping"], undefined)).toBe("ping");
  });
});

describe("argumentDocs", () => {
  it("renders every ArgDef field", () => {
    const docs = argumentDocs({
      env: { type: "string", required: true, choices: ["dev", "prod"], description: "Target environment" },
      timeout: { type: "duration", default: "30s", description: "Rollout timeout" },
      replicas: { type: "number", min: 1, max: 10, description: "Replica count" },
      verbose: { type: "boolean", description: "Chatty output" },
      tags: { type: "string", rest: true, description: "Extra tags" },
    });
    expect(docs).toEqual([
      "env (string, required, one of: dev|prod) Target environment",
      'timeout (duration, default "30s") Rollout timeout',
      "replicas (number, minimum 1, maximum 10) Replica count",
      "verbose (boolean) Chatty output",
      "tags (string...) Extra tags",
    ]);
  });

  it("returns nothing without a schema", () => {
    expect(argumentDocs(undefined)).toEqual([]);
  });
});

describe("buildHelpOverview", () => {
  const catalog = catalogFromEntries(FIXTURE_ENTRIES);

  it("groups plugins alphabetically with sorted commands and indented subcommands", () => {
    const lines = buildHelpOverview(catalog);
    expect(lines[0]).toBe("Commands:");
    const apple = lines.indexOf("  apple - Peel an apple.");
    const banana = lines.indexOf("  banana - Split a banana.");
    const note = lines.findIndex((line) => line.startsWith("  note - Manage notes."));
    const noteAdd = lines.findIndex((line) => line.startsWith("    note add - Add a note."));
    const noteUndo = lines.findIndex((line) => line.startsWith("      note add undo - Undo the last note."));
    const zebra = lines.indexOf("  zebra - Zebra stripes.");
    expect(apple).toBeGreaterThan(0);
    expect(banana).toBeGreaterThan(apple);
    expect(note).toBeGreaterThan(banana);
    expect(noteAdd).toBeGreaterThan(note);
    expect(noteUndo).toBeGreaterThan(noteAdd);
    expect(zebra).toBeGreaterThan(noteUndo);
  });

  it("ends with the drill-down hint using the configured prefix", () => {
    const lines = buildHelpOverview(catalog, { prefix: "??" });
    expect(lines[lines.length - 1]).toBe('Run "??help <command>" for details.');
  });

  it("never lists hidden commands", () => {
    const joined = buildHelpOverview(catalog).join("\n");
    expect(joined).not.toContain("backdoor");
  });

  it("is deterministic across calls", () => {
    expect(buildHelpOverview(catalog)).toEqual(buildHelpOverview(catalog));
  });
});

describe("buildHelpDetail", () => {
  const catalog = catalogFromEntries(FIXTURE_ENTRIES);

  it("renders description, usage, every argument field, aliases, and subcommands", () => {
    const lines = buildHelpDetail(catalog, ["deploy"]);
    expect(lines).not.toBeNull();
    expect(lines![0]).toBe("deploy - Ship it.");
    expect(lines).toContain(`Usage: !${usageLine(["deploy"], FIXTURE_ENTRIES[6]!.args)}`);
    expect(lines).toContain("Usage: !deploy <env> [timeout] [replicas] [verbose] [tags...]");
    expect(lines).toContain("Arguments:");
    expect(lines).toContain("  env (string, required, one of: dev|prod) Target environment");
    expect(lines).toContain('  timeout (duration, default "30s") Rollout timeout');
    expect(lines).toContain("  replicas (number, minimum 1, maximum 10) Replica count");
    expect(lines).toContain("  verbose (boolean) Chatty output");
    expect(lines).toContain("  tags (string...) Extra tags");
    expect(lines).toContain("Aliases: ship");
  });

  it("lists visible subcommands of the target node", () => {
    const lines = buildHelpDetail(catalog, ["note"]);
    expect(lines).toContain("Subcommands:");
    expect(lines).toContain("  note add - Add a note.");
    const joined = lines!.join("\n");
    expect(joined).not.toContain("backdoor");
  });

  it("resolves aliases to the canonical detail", () => {
    const lines = buildHelpDetail(catalog, ["note", "a"]);
    expect(lines![0]).toBe("note add - Add a note.");
    const topLevelAlias = buildHelpDetail(catalog, ["ship"]);
    expect(topLevelAlias![0]).toBe("deploy - Ship it.");
  });

  it("returns null for unknown targets including hidden ones", () => {
    expect(buildHelpDetail(catalog, ["nope"])).toBeNull();
    expect(buildHelpDetail(catalog, ["backdoor"])).toBeNull();
  });
});

describe("generateMarkdownDocs", () => {
  const catalog = catalogFromEntries(FIXTURE_ENTRIES);

  it("emits headings, fenced usage, and bullet arguments for a fixed fixture", () => {
    const markdown = generateMarkdownDocs(catalog, { title: "Command Reference" });
    expect(markdown.startsWith("# Command Reference\n")).toBe(true);
    const alpha = markdown.indexOf("## alpha");
    const zeta = markdown.indexOf("## zeta");
    expect(alpha).toBeGreaterThan(-1);
    expect(zeta).toBeGreaterThan(alpha);
    expect(markdown).toContain("### note add undo\n");
    expect(markdown).toContain("```");
    expect(markdown).toContain("```\n!deploy <env> [timeout] [replicas] [verbose] [tags...]\n```");
    expect(markdown).toContain("- env (string, required, one of: dev|prod) Target environment");
    expect(markdown).toContain("- body (string..., required) Note text.");
    expect(markdown).toContain("Aliases: a");
    expect(markdown).toContain("Aliases: ship");
    expect(markdown).not.toContain("backdoor");
  });

  it("keeps declaration order inside a plugin", () => {
    const markdown = generateMarkdownDocs(catalog, { title: "Command Reference" });
    const banana = markdown.indexOf("### banana");
    const apple = markdown.indexOf("### apple");
    expect(banana).toBeGreaterThan(-1);
    expect(apple).toBeGreaterThan(banana);
  });

  it("is deterministic across runs", () => {
    const first = generateMarkdownDocs(catalog, { title: "Command Reference" });
    const second = generateMarkdownDocs(catalog, { title: "Command Reference" });
    expect(first).toEqual(second);
  });
});
