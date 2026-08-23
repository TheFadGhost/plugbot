import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgv } from "../src/cli/argv.js";
import { COMMAND_HELP, ROOT_HELP, ROOT_HINT } from "../src/cli/helpTexts.js";
import { runCli } from "../src/cli/main.js";

const TMP_ROOT = join(process.cwd(), "tests", "tmp-cli");

interface FakeSink {
  readonly chunks: string[];
  readonly writable: NodeJS.WritableStream;
}

function fakeStream(): FakeSink {
  const chunks: string[] = [];
  const writable = {
    write(chunk: string | Uint8Array): boolean {
      if (typeof chunk === "string") chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { chunks, writable };
}

function makeCase(): { caseDir: string; stdout: FakeSink; stderr: FakeSink } {
  const caseDir = mkdtempSync(join(TMP_ROOT, "case-"));
  return { caseDir, stdout: fakeStream(), stderr: fakeStream() };
}

async function expectExit(
  argv: readonly string[],
  caseReturn: { stdout: FakeSink; stderr: FakeSink },
): Promise<number> {
  return await runCli(argv, { stdout: caseReturn.stdout.writable, stderr: caseReturn.stderr.writable }, {});
}

beforeEach(() => {
  mkdirSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best effort; EBUSY retried above
  }
});

describe("argv parsing", () => {
  it("accepts equals-form value flags", () => {
    const parsed = parseArgv(["run", "--config=x.json"]);
    expect(parsed.command).toBe("run");
    expect(parsed.flags["--config"]).toBe("x.json");
    expect(parsed.errors).toEqual([]);
  });

  it("collects global flags before the command", () => {
    const parsed = parseArgv(["--log-json", "run"]);
    expect(parsed.command).toBe("run");
    expect(parsed.flags["--log-json"]).toBe(true);
  });

  it("consumes separated values for value flags", () => {
    const parsed = parseArgv(["--config", "a.json", "doctor"]);
    expect(parsed.command).toBe("doctor");
    expect(parsed.flags["--config"]).toBe("a.json");
  });

  it("reports unknown flags", () => {
    const parsed = parseArgv(["run", "--wat"]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("--wat");
  });

  it("reports value flags missing their value", () => {
    const parsed = parseArgv(["--config"]);
    expect(parsed.errors.join("\n")).toMatch(/requires a value/);
  });

  it("keeps tokens after the command as positionals", () => {
    const parsed = parseArgv(["new", "ping", "extra"]);
    expect(parsed.positionals).toEqual(["ping", "extra"]);
  });

  it("recognises -h and leaves no-command input alone", () => {
    expect(parseArgv(["-h"]).flags["-h"]).toBe(true);
    expect(parseArgv(["--version"]).command).toBeNull();
  });
});

describe("runCli basics", () => {
  it("prints the version number", async () => {
    const kase = makeCase();
    const code = await expectExit(["--version"], kase);
    expect(code).toBe(0);
    expect(kase.stdout.chunks.join("")).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("prints ROOT_HELP for every help variant with exit 0", async () => {
    const cases: ReadonlyArray<readonly string[]> = [["--help"], ["-h"], [], ["help"]];
    for (const argv of cases) {
      const kase = makeCase();
      const code = await expectExit(argv, kase);
      expect(code).toBe(0);
      expect(kase.stdout.chunks.join("")).toBe(ROOT_HELP);
    }
  });

  it("help <command> prints that command's help verbatim", async () => {
    const kase = makeCase();
    const code = await expectExit(["help", "run"], kase);
    expect(code).toBe(0);
    expect(kase.stdout.chunks.join("")).toBe(COMMAND_HELP["run"]);
  });

  it("rejects unknown help topics with the root hint", async () => {
    const kase = makeCase();
    const code = await expectExit(["help", "bogus"], kase);
    expect(code).toBe(1);
    const errText = kase.stderr.chunks.join("");
    expect(errText).toContain('unknown command "bogus"');
    expect(errText).toContain(ROOT_HINT);
  });

  it("rejects unknown commands", async () => {
    const kase = makeCase();
    const code = await expectExit(["frobnicate"], kase);
    expect(code).toBe(1);
    expect(kase.stderr.chunks.join("")).toContain('error: unknown command "frobnicate"');
  });
});

describe("plugbot new", () => {
  it("creates a skeleton file and prints next steps", async () => {
    const kase = makeCase();
    const pluginsDir = join(kase.caseDir, "plugins");
    const code = await expectExit(["new", "myping", "--dir", pluginsDir], kase);
    expect(code).toBe(0);
    const filePath = join(pluginsDir, "myping.ts");
    expect(existsSync(filePath)).toBe(true);
    const source = readFileSync(filePath, "utf8");
    expect(source).toContain('import { definePlugin } from "plugbot";');
    expect(source).toContain('name: "myping"');
    expect(source).toContain("ctx.reply");
    const outText = kase.stdout.chunks.join("");
    expect(outText).toContain(`created ${filePath}`);
    expect(outText).toContain("plugbot dev");
  });

  it("rejects names violating the rule", async () => {
    const kase = makeCase();
    const code = await expectExit(["new", "Bad_Name", "--dir", kase.caseDir], kase);
    expect(code).toBe(1);
    expect(kase.stderr.chunks.join("")).toMatch(/invalid plugin name "Bad_Name"/);
  });

  it("refuses to overwrite an existing file", async () => {
    const kase = makeCase();
    const pluginsDir = join(kase.caseDir, "plugins");
    expect(await expectExit(["new", "twice", "--dir", pluginsDir], kase)).toBe(0);
    const secondCode = await expectExit(["new", "twice", "--dir", pluginsDir], kase);
    expect(secondCode).toBe(1);
    expect(kase.stderr.chunks.join("")).toContain("refusing to overwrite");
  });
});

describe("plugbot doctor", () => {
  it("validates a good config and lists candidates without starting anything", async () => {
    const kase = makeCase();
    const cfgPath = join(kase.caseDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      storage: { file: join(kase.caseDir, "storage.json") },
      plugins: { dir: join(kase.caseDir, "plugins") },
    }), "utf8");
    const code = await expectExit(["doctor", "--config", cfgPath], kase);
    expect(code).toBe(0);
    const lines = kase.stdout.chunks.join("").split("\n");
    expect(lines[0]).toBe(`config ok (${cfgPath})`);
    expect(kase.stdout.chunks.join("")).toContain("adapter: mock");
    expect(kase.stdout.chunks.join("")).toContain("plugin candidates: 0");
  });

  it("exits 2 with rendered violations for an invalid config", async () => {
    const kase = makeCase();
    const cfgPath = join(kase.caseDir, "bad.json");
    writeFileSync(cfgPath, JSON.stringify({ adapter: { type: "slack" } }), "utf8");
    const code = await expectExit(["doctor", "--config", cfgPath], kase);
    expect(code).toBe(2);
    const errText = kase.stderr.chunks.join("");
    expect(errText).toContain("config error:");
    expect(errText).toContain("adapter.type");
  });
});

describe("plugbot docs", () => {
  function writeDocsDemo(caseDir: string): { pluginsDir: string; cfgPath: string } {
    const pluginsDir = join(caseDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "docsdemo.ts"), `import { definePlugin } from "plugbot";

export default definePlugin({
  name: "docsdemo",
  description: "Docs demo plugin.",
  commands: {
    hi: {
      description: "Say hi.",
      async run(ctx) {
        await ctx.reply("hi");
      },
    },
  },
});
`, "utf8");
    const cfgPath = join(caseDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({
      plugins: { dir: pluginsDir, isolation: "inline" },
      storage: { file: join(caseDir, "storage.json") },
    }), "utf8");
    return { pluginsDir, cfgPath };
  }

  it("prints markdown containing the heading and declared commands", async () => {
    const kase = makeCase();
    const { cfgPath } = writeDocsDemo(kase.caseDir);
    const code = await expectExit(["docs", "--config", cfgPath], kase);
    expect(code).toBe(0);
    const markdown = kase.stdout.chunks.join("");
    expect(markdown).toContain("# Plugbot command reference");
    expect(markdown).toContain("## docsdemo");
    expect(markdown).toContain("hi");
    expect(kase.stderr.chunks.join("")).toContain("docs generated (1 commands)");
  }, 30000);

  it("writes markdown to --out when given", async () => {
    const kase = makeCase();
    const { cfgPath } = writeDocsDemo(kase.caseDir);
    const outFile = join(kase.caseDir, "out", "commands.md");
    const code = await expectExit(["docs", "--config", cfgPath, "--out", outFile], kase);
    expect(code).toBe(0);
    expect(existsSync(outFile)).toBe(true);
    expect(readFileSync(outFile, "utf8")).toContain("# Plugbot command reference");
  }, 30000);
});

describe("plugbot run flag validation", () => {
  it("exits 2 naming the flag for an invalid --adapter override", async () => {
    const kase = makeCase();
    const cfgPath = join(kase.caseDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ adapter: { type: "mock" } }), "utf8");
    const code = await expectExit(["run", "--config", cfgPath, "--adapter", "slack"], kase);
    expect(code).toBe(2);
    const errText = kase.stderr.chunks.join("");
    expect(errText).toContain("--adapter");
    expect(errText).toContain('"slack"');
  });

  it("exits 2 naming the flag for an invalid --log-level override", async () => {
    const kase = makeCase();
    const cfgPath = join(kase.caseDir, "config.json");
    writeFileSync(cfgPath, JSON.stringify({ adapter: { type: "mock" } }), "utf8");
    const code = await expectExit(["run", "--config", cfgPath, "--log-level", "loudly"], kase);
    expect(code).toBe(2);
    expect(kase.stderr.chunks.join("")).toContain("--log-level");
  });

  it("exits 2 with rendered violations when the config is invalid", async () => {
    const kase = makeCase();
    const cfgPath = join(kase.caseDir, "bad.json");
    writeFileSync(cfgPath, JSON.stringify({ adapter: { type: "teams" } }), "utf8");
    const code = await expectExit(["run", "--config", cfgPath], kase);
    expect(code).toBe(2);
    expect(kase.stderr.chunks.join("")).toContain("config error:");
  });
});
