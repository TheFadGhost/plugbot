import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OutboundApi, PluginStore } from "../src/plugin/types.js";
import type { Capabilities } from "../src/adapter/adapter.js";
import type { Clock } from "../src/clock.js";
import type { LogRecord, Logger } from "../src/logging/types.js";
import type { Message } from "../src/types.js";
import { loadPlugins } from "../src/runtime/loader.js";
import { watchPluginsDir } from "../src/runtime/reloadWatcher.js";

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

const ALL_CAPABILITIES: Capabilities = {
  send: true,
  edit: true,
  delete: true,
  react: true,
  threads: true,
  typing: true,
  memberEvents: true,
  userLookup: true,
  channelLookup: true,
  roles: true,
};

const PLUGIN_V1 = `// @ts-nocheck
export default {
  name: "counter",
  commands: {
    word: {
      description: "says the word",
      run: (ctx) => ctx.reply("one"),
    },
  },
};
`;

const PLUGIN_V2 = PLUGIN_V1.replace('"one"', '"two"');

function capturingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const build = (name: string): Logger => ({
    debug: (msg, fields) => records.push({ time: Date.now(), level: "debug", name, msg, fields: fields ?? {} }),
    info: (msg, fields) => records.push({ time: Date.now(), level: "info", name, msg, fields: fields ?? {} }),
    warn: (msg, fields) => records.push({ time: Date.now(), level: "warn", name, msg, fields: fields ?? {} }),
    error: (msg, fields) => records.push({ time: Date.now(), level: "error", name, msg, fields: fields ?? {} }),
    child: (suffix) => build(`${name}:${suffix}`),
  });
  return Object.assign(build("root"), { records });
}

function fakeOutbound(): OutboundApi & { sends: Array<{ channelId: string; text: string }> } {
  const sends: Array<{ channelId: string; text: string }> = [];
  return Object.assign(
    {
      async send(channelId: string, text: string) {
        sends.push({ channelId, text });
        return { channelId, messageId: `m${sends.length}` };
      },
      async editMessage() {},
      async deleteMessage() {},
      async react() {},
      async startTyping() {
        return { stop: async () => {} };
      },
      async getUser() {
        return null;
      },
      async getChannel() {
        return null;
      },
    },
    { sends },
  );
}

function makeMessage(): Message {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    text: "",
    author: { id: "u1", username: "alice" },
    channelId: "ch1",
    createdAt: Date.now(),
    mentions: [],
  };
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

describe("plugin loading and hot reload", () => {
  let rootDir: string;
  let pluginsDir: string;
  let logger: ReturnType<typeof capturingLogger>;
  let outbound: ReturnType<typeof fakeOutbound>;
  const stores = new Map<string, PluginStore>();
  let loaded: Awaited<ReturnType<typeof loadPlugins>> | null = null;
  const watchers: Array<{ close(): void }> = [];

  function storeNamespaceFor(name: string): PluginStore {
    const existing = stores.get(name);
    if (existing !== undefined) return existing;
    const entries = new Map<string, unknown>();
    const store: PluginStore = {
      async get<T>(key: string) {
        return entries.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T) {
        entries.set(key, value);
      },
      async delete(key: string) {
        return entries.delete(key);
      },
      async list(prefix?: string) {
        return [...entries.entries()]
          .filter(([key]) => prefix === undefined || key.startsWith(prefix))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      },
      async clear() {
        entries.clear();
      },
    };
    stores.set(name, store);
    return store;
  }

  function loadFrom(dir: string) {
    return loadPlugins({
      dir,
      disabled: [],
      isolation: "thread",
      limits: { handlerTimeoutMs: 2_000, breakerThreshold: 5, breakerWindowMs: 60_000, breakerCooldownMs: 1_000 },
      clock: realClock,
      logger,
      outbound: outbound as OutboundApi,
      storeNamespaceFor,
      capabilities: ALL_CAPABILITIES,
      configFor: () => ({}),
    });
  }

  function invokeCounterWord(): Promise<void> {
    const runtime = loaded?.registry.get("counter");
    if (runtime === undefined) throw new Error("counter plugin not registered");
    return runtime.invokeCommand(["word"], makeMessage(), {}, []);
  }

  beforeEach(() => {
    const base = resolve("tests", "tmp-runtime");
    mkdirSync(base, { recursive: true });
    rootDir = mkdtempSync(join(base, "hotreload-"));
    pluginsDir = join(rootDir, "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    logger = capturingLogger();
    outbound = fakeOutbound();
    stores.clear();
  });

  afterEach(async () => {
    for (const watcher of watchers.splice(0)) watcher.close();
    if (loaded !== null) {
      await loaded.disposeAll(500).catch(() => {});
      loaded = null;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(rootDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }, 20_000);

  it("reloads a changed file with identical registry counts and no duplicate replies", async () => {
    const counterPath = join(pluginsDir, "counter.ts");
    writeFileSync(counterPath, PLUGIN_V1, "utf8");

    loaded = await loadFrom(pluginsDir);
    expect(loaded.registry.get("counter")).toBeDefined();
    const countsBefore = JSON.stringify(loaded.registrationCounts());
    await invokeCounterWord();
    expect(outbound.sends).toEqual([{ channelId: "ch1", text: "one" }]);

    writeFileSync(counterPath, PLUGIN_V2, "utf8");
    const outcome = await loaded.reloadFile(counterPath);
    expect(outcome).toBe("reloaded");

    const countsAfter = JSON.stringify(loaded.registrationCounts());
    expect(countsAfter).toBe(countsBefore);

    const sendsBefore = outbound.sends.length;
    await invokeCounterWord();
    await invokeCounterWord();
    expect(outbound.sends.slice(sendsBefore)).toEqual([
      { channelId: "ch1", text: "two" },
      { channelId: "ch1", text: "two" },
    ]);
  }, 20_000);

  it("reports unchanged for byte-identical files and reloads cosmetic changes safely", async () => {
    const counterPath = join(pluginsDir, "counter.ts");
    writeFileSync(counterPath, PLUGIN_V1, "utf8");
    loaded = await loadFrom(pluginsDir);

    writeFileSync(counterPath, PLUGIN_V1, "utf8");
    const identicalOutcome = await loaded.reloadFile(counterPath);
    expect(identicalOutcome).toBe("unchanged");

    writeFileSync(counterPath, PLUGIN_V1 + "\n// touched\n", "utf8");
    const cosmeticOutcome = await loaded.reloadFile(counterPath);
    expect(cosmeticOutcome).toBe("reloaded");

    await invokeCounterWord();
    expect(outbound.sends).toEqual([{ channelId: "ch1", text: "one" }]);
  }, 20_000);

  it("unregisters a deleted plugin", async () => {
    const counterPath = join(pluginsDir, "counter.ts");
    writeFileSync(counterPath, PLUGIN_V1, "utf8");
    loaded = await loadFrom(pluginsDir);
    expect(loaded.registry.get("counter")).toBeDefined();

    rmSync(counterPath);
    const outcome = await loaded.reloadFile(counterPath);
    expect(outcome).toBe("removed");
    expect(loaded.registry.get("counter")).toBeUndefined();
    expect(loaded.registry.all()).toHaveLength(0);
  }, 20_000);

  it("skips a broken plugin and keeps the bot alive", async () => {
    writeFileSync(join(pluginsDir, "broken.ts"), "export default { name: 'broken', commands: { x: {} } };", "utf8");
    writeFileSync(join(pluginsDir, "counter.ts"), PLUGIN_V1, "utf8");
    loaded = await loadFrom(pluginsDir);

    expect(loaded.registry.get("broken")).toBeUndefined();
    expect(loaded.registry.get("counter")).toBeDefined();
    expect(logger.records.some((record) => record.level === "error" && record.name.endsWith("loader"))).toBe(true);
  }, 20_000);

  it("collapses rapid successive writes into one onChange callback", async () => {
    const watchedDir = join(rootDir, "watched");
    mkdirSync(watchedDir, { recursive: true });
    const target = join(watchedDir, "watched-plugin.ts");
    const seen: string[] = [];
    watchers.push(watchPluginsDir(watchedDir, (filePath) => seen.push(filePath)));

    await sleep(120);
    writeFileSync(target, "// v1", "utf8");
    await sleep(40);
    writeFileSync(target, "// v2", "utf8");
    await sleep(40);
    writeFileSync(target, "// v3", "utf8");

    await sleep(700);
    const firedForTarget = seen.filter((filePath) => filePath === target);
    expect(firedForTarget).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toBe("// v3");
    expect(existsSync(target)).toBe(true);
  }, 9_000);
});
