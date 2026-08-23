import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OutboundApi, PluginStore } from "../src/plugin/types.js";
import type { Capabilities } from "../src/adapter/adapter.js";
import type { Clock } from "../src/clock.js";
import type { LogRecord, Logger } from "../src/logging/types.js";
import type { Message } from "../src/types.js";
import { HandlerTimeoutError } from "../src/errors.js";
import { ThreadPluginRuntime } from "../src/runtime/workerBridge.js";

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

function memoryStore(): PluginStore & { writes: Array<[string, unknown]> } {
  const entries = new Map<string, unknown>();
  const writes: Array<[string, unknown]> = [];
  return Object.assign(
    {
      async get<T>(key: string) {
        return entries.get(key) as T | undefined;
      },
      async set<T>(key: string, value: T) {
        entries.set(key, value);
        writes.push([key, value]);
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
    },
    { writes },
  );
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

function makeMessage(id: string): Message {
  return {
    id,
    text: "",
    author: { id: `user-${id}`, username: "alice" },
    channelId: "ch1",
    createdAt: Date.now(),
    mentions: [],
  };
}

const FIXTURES: Record<string, string> = {
  "thrower.ts": `// @ts-nocheck
export default {
  name: "thrower",
  commands: {
    slowBoom: {
      description: "fails slowly",
      run: () => new Promise((_, reject) => {
        setTimeout(() => reject(new Error("boom-from-plugin")), 200);
      }),
    },
  },
};
`,
  "healthy.ts": `// @ts-nocheck
export default {
  name: "healthy",
  commands: {
    hello: {
      description: "replies",
      run: (ctx) => ctx.reply("hi-there"),
    },
  },
};
`,
  "hang.ts": `// @ts-nocheck
export default {
  name: "hang",
  commands: {
    hang: {
      description: "never returns",
      run: () => new Promise(() => {}),
    },
    alive: {
      description: "proves the worker responds again",
      run: (ctx) => ctx.reply("still-here"),
    },
  },
};
`,
  "spin.ts": `// @ts-nocheck
export default {
  name: "spinner",
  commands: {
    spin: {
      description: "burns cpu synchronously",
      run: () => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {}
      },
    },
  },
};
`,
  "rpc.ts": `// @ts-nocheck
export default {
  name: "rpc",
  commands: {
    save: {
      description: "exercises store, reply, logger",
      run: async (ctx) => {
        await ctx.store.set("greeting", "yo");
        await ctx.reply("saved");
        ctx.logger.info("saved-note", { n: 42 });
      },
    },
  },
};
`,
  "abortable.ts": `// @ts-nocheck
export default {
  name: "abortable",
  commands: {
    waitout: {
      description: "resolves when aborted",
      run: (ctx) =>
        new Promise((resolve) => {
          ctx.logger.info("waiting");
          ctx.signal.addEventListener("abort", () => resolve());
        }),
    },
  },
};
`,
};

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(predicate: () => boolean, deadlineMs = 3_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

describe("plugin thread isolation", () => {
  let rootDir: string;
  const runtimes: ThreadPluginRuntime[] = [];

  function makeDeps() {
    const logger = capturingLogger();
    const outbound = fakeOutbound();
    const store = memoryStore();
    return { logger, outbound, store };
  }

  function makeRuntime(
    file: string,
    deps: ReturnType<typeof makeDeps>,
    handlerTimeoutMs = 300,
  ): ThreadPluginRuntime {
    const runtime = new ThreadPluginRuntime({
      pluginFile: file,
      pluginName: file.replace(/\.ts$/, "").split(/[\\/]/).pop() ?? file,
      limits: { handlerTimeoutMs, breakerThreshold: 10, breakerWindowMs: 60_000, breakerCooldownMs: 500 },
      clock: realClock,
      logger: deps.logger,
      outbound: deps.outbound as OutboundApi,
      store: deps.store as PluginStore,
      capabilities: ALL_CAPABILITIES,
      config: {},
    });
    runtimes.push(runtime);
    return runtime;
  }

  function writeFixtures(dir: string, names: string[]): void {
    for (const name of names) {
      writeFileSync(join(dir, name), FIXTURES[name] ?? "", "utf8");
    }
  }

  beforeEach(() => {
    const base = resolve("tests", "tmp-runtime");
    mkdirSync(base, { recursive: true });
    rootDir = mkdtempSync(join(base, "isolation-"));
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(rootDir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  });

  it("contains a throwing plugin while a second plugin stays responsive", async () => {
    writeFixtures(rootDir, ["thrower.ts", "healthy.ts"]);
    const deps = makeDeps();
    const thrower = makeRuntime(join(rootDir, "thrower.ts"), deps);
    const healthy = makeRuntime(join(rootDir, "healthy.ts"), deps);
    await thrower.init();
    await healthy.init();

    const slowBoom = thrower.invokeCommand(["slowBoom"], makeMessage("a1"), {}, []);
    await sleep(30);
    const startedAt = Date.now();
    await healthy.invokeCommand(["hello"], makeMessage("b1"), {}, []);
    const healthyElapsedMs = Date.now() - startedAt;
    expect(healthyElapsedMs).toBeLessThan(500);

    await expect(slowBoom).rejects.toMatchObject({ code: "PLUGIN_HANDLER_FAILED" });
    await expect(slowBoom).rejects.toMatchObject({
      fields: { plugin: "thrower", handlerKind: "command", handler: "slowBoom" },
    });
    expect(deps.outbound.sends.some((send) => send.text === "hi-there")).toBe(true);
    expect(thrower.breaker.stateForTests().failuresInWindow).toBe(1);
  });

  it("terminates a hanging worker at the timeout and recovers on next use", async () => {
    writeFixtures(rootDir, ["hang.ts"]);
    const deps = makeDeps();
    const hang = makeRuntime(join(rootDir, "hang.ts"), deps, 300);
    await hang.init();

    const startedAt = Date.now();
    await expect(hang.invokeCommand(["hang"], makeMessage("h1"), {}, [])).rejects.toBeInstanceOf(
      HandlerTimeoutError,
    );
    const hungForMs = Date.now() - startedAt;
    expect(hungForMs).toBeGreaterThanOrEqual(280);
    expect(hungForMs).toBeLessThan(2_000);

    await hang.invokeCommand(["alive"], makeMessage("h2"), {}, []);
    expect(deps.outbound.sends).toContainEqual({ channelId: "ch1", text: "still-here" });
  });

  it("contains a synchronous CPU spin without blocking another plugin", async () => {
    writeFixtures(rootDir, ["spin.ts", "healthy.ts"]);
    const deps = makeDeps();
    const spinner = makeRuntime(join(rootDir, "spin.ts"), deps, 250);
    const healthy = makeRuntime(join(rootDir, "healthy.ts"), deps, 1_000);
    await spinner.init();
    await healthy.init();

    let spinFailedAt = 0;
    let healthyDoneAt = 0;
    const spinRaw = spinner.invokeCommand(["spin"], makeMessage("s1"), {}, []);
    const spin = spinRaw.catch((error: unknown) => {
      spinFailedAt = Date.now();
      throw error;
    });
    const helloRaw = healthy.invokeCommand(["hello"], makeMessage("s2"), {}, []);
    const hello = helloRaw.then(() => {
      healthyDoneAt = Date.now();
    });

    const outcomes = await Promise.allSettled([spin, hello]);
    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[1].status).toBe("fulfilled");
    expect(healthyDoneAt).toBeGreaterThan(0);
    expect(spinFailedAt).toBeGreaterThan(0);
    expect(healthyDoneAt).toBeLessThan(spinFailedAt);
    await expect(spinRaw).rejects.toBeInstanceOf(HandlerTimeoutError);
    expect(deps.outbound.sends.some((send) => send.text === "hi-there")).toBe(true);
  }, 20_000);

  it("round-trips store, outbound, and log calls through nested RPC", async () => {
    writeFixtures(rootDir, ["rpc.ts"]);
    const deps = makeDeps();
    const rpcPlugin = makeRuntime(join(rootDir, "rpc.ts"), deps);
    await rpcPlugin.init();

    await rpcPlugin.invokeCommand(["save"], makeMessage("r1"), {}, []);

    expect(deps.store.writes).toContainEqual(["greeting", "yo"]);
    expect(deps.outbound.sends).toEqual([{ channelId: "ch1", text: "saved" }]);
    const record = deps.logger.records.find((entry) => entry.msg === "saved-note");
    expect(record).toBeDefined();
    expect(record?.name.endsWith("plugin:rpc")).toBe(true);
    expect(record?.fields.n).toBe(42);
    expect(record?.level).toBe("info");
  });

  it("propagates host aborts into the handler signal", async () => {
    writeFixtures(rootDir, ["abortable.ts"]);
    const deps = makeDeps();
    const abortable = makeRuntime(join(rootDir, "abortable.ts"), deps, 5_000);
    await abortable.init();

    const waiting = abortable.invokeCommand(["waitout"], makeMessage("w1"), {}, []);
    await waitFor(() => deps.logger.records.some((entry) => entry.msg === "waiting"));
    abortable.abortActiveInvocations();
    await expect(waiting).resolves.toBeUndefined();
  });
});
