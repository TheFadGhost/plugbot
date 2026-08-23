import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TestBot,
  allocateHarnessPaths,
  configHarnessPaths,
  makeTestConfig,
  removeHarnessPaths,
} from "../src/testing/harness.js";
import type { TranscriptPage } from "../src/testing/harness.js";
import type { LimitsConfig } from "../src/config/types.js";
import { TranscriptAdapter } from "../src/adapter/transcript.js";
import { startBot } from "../src/runtime/bot.js";

function partialLimits(values: Partial<LimitsConfig>): LimitsConfig {
  return values as LimitsConfig;
}

const PING_PLUGIN = `// @ts-nocheck
export default {
  name: "ping",
  commands: {
    ping: {
      description: "Reply with pong.",
      run: (ctx) => ctx.reply("pong"),
    },
    slow: {
      description: "Replies after a real pause.",
      run: (ctx) => new Promise((done) => {
        setTimeout(() => { ctx.reply("slow-pong").then(done, done); }, 150);
      }),
    },
  },
};
`;

const HELLO_PLUGIN = `// @ts-nocheck
export default {
  name: "greet",
  commands: {
    hello: {
      description: "HELLO_DESCRIPTION_MARKER",
      run: (ctx) => ctx.reply("hi-there"),
    },
    squirrel: {
      description: "HIDDEN_SQUIRREL_MARKER",
      hidden: true,
      run: (ctx) => ctx.reply("squirrel-ran"),
    },
  },
};
`;

const MATH_PLUGIN = `// @ts-nocheck
export default {
  name: "math",
  commands: {
    add: {
      description: "Add two numbers.",
      args: {
        a: { type: "number", required: true, description: "First addend." },
        b: { type: "number", required: true, description: "Second addend." },
      },
      run: async (ctx) => {
        await ctx.reply(String(ctx.args.a + ctx.args.b));
      },
    },
  },
};
`;

const ADMIN_PLUGIN = `// @ts-nocheck
export default {
  name: "secure",
  commands: {
    secret: {
      description: "Admin only.",
      permission: "admin",
      run: (ctx) => ctx.reply("granted"),
    },
  },
};
`;

const FLAKY_PLUGIN = `// @ts-nocheck
let executions = 0;
export default {
  name: "flaky",
  commands: {
    flip: {
      description: "Fails twice then heals.",
      run: async (ctx) => {
        executions += 1;
        if (executions <= 2) throw new Error("flaky-boom");
        await ctx.reply("healed");
      },
    },
  },
};
`;

const MEMO_PLUGIN = `// @ts-nocheck
export default {
  name: "memo",
  commands: {
    remember: {
      description: "Store a note.",
      args: {
        value: { type: "string", rest: true, required: true, description: "Note text." },
      },
      run: async (ctx) => {
        const note = ctx.args.value.join(" ");
        await ctx.store.set("note", note);
        await ctx.reply("stored " + note);
      },
    },
    recall: {
      description: "Read the note.",
      run: async (ctx) => {
        const note = await ctx.store.get("note");
        await ctx.reply(note === undefined ? "nothing stored" : String(note));
      },
    },
  },
};
`;

const WORD_V1 = `// @ts-nocheck
export default {
  name: "counter",
  commands: {
    word: {
      description: "Says the word.",
      run: (ctx) => ctx.reply("one"),
    },
  },
};
`;

const WORD_V2 = WORD_V1.replace('"one"', '"two"');

function textsOf(page: TranscriptPage): string[] {
  return page.texts().map((line) => line.text);
}

function joinedTexts(page: TranscriptPage): string {
  return textsOf(page).join("\n");
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitFor(
  probe: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(15);
  }
}

describe("e2e commands through startBot", () => {
  const bots: TestBot[] = [];

  afterEach(async () => {
    for (const bot of bots.splice(0)) {
      try {
        await bot.stop();
      } catch {
        // best-effort teardown
      }
    }
  });

  it("dispatches prefix commands and lands the reply", async () => {
    const bot = await TestBot.create({ pluginSources: { "ping.ts": PING_PLUGIN } });
    bots.push(bot);
    const page = await bot.receive({ text: "!ping" });
    expect(textsOf(page)).toContain("pong");
    expect(await bot.stop()).not.toBeNull();
  });

  it("accepts mention aliases configured via overrides", async () => {
    const bot = await TestBot.create({
      pluginSources: { "hello.ts": HELLO_PLUGIN },
      configOverrides: { commands: { prefix: "!", mentionAliases: ["bot:"] } },
    });
    bots.push(bot);
    const page = await bot.receive({ text: "bot: hello" });
    expect(textsOf(page)).toContain("hi-there");
  });

  it("answers coercion failures with a usage reply containing the problem line", async () => {
    const bot = await TestBot.create({ pluginSources: { "math.ts": MATH_PLUGIN } });
    bots.push(bot);
    const page = await bot.receive({ text: "!add abc 2" });
    const reply = joinedTexts(page);
    expect(reply).toContain("usage:");
    expect(reply).toContain("problem:");
    expect(reply).toContain("!add <a> <b>");
  });

  it("replies to unknown commands", async () => {
    const bot = await TestBot.create({ pluginSources: { "ping.ts": PING_PLUGIN } });
    bots.push(bot);
    const page = await bot.receive({ text: "!wibble" });
    expect(joinedTexts(page)).toContain('unknown command "wibble"');
  });

  it("keeps generated help in sync and hides hidden commands", async () => {
    const bot = await TestBot.create({
      pluginSources: { "hello.ts": HELLO_PLUGIN, "admin.ts": ADMIN_PLUGIN },
    });
    bots.push(bot);
    const help = joinedTexts(await bot.receive({ text: "!help" }));
    expect(help).toContain("HELLO_DESCRIPTION_MARKER");
    expect(help).toContain("Admin only.");
    expect(help).not.toContain("HIDDEN_SQUIRREL_MARKER");
    const detail = joinedTexts(await bot.receive({ text: "!help hello" }));
    expect(detail).toContain("HELLO_DESCRIPTION_MARKER");
    expect(bot.commandNames()).toContain("hello");
    expect(bot.commandNames()).not.toContain("squirrel");
  });

  it("denies unprivileged users and admits configured admins on a second bot", async () => {
    const denied = await TestBot.create({
      pluginSources: { "admin.ts": ADMIN_PLUGIN },
    });
    bots.push(denied);
    expect(joinedTexts(await denied.receive({ text: "!secret" }))).toContain(
      "you don't have permission to run that command",
    );

    const allowed = await TestBot.create({
      pluginSources: { "admin.ts": ADMIN_PLUGIN },
      configOverrides: { permissions: { adminUserIds: ["u-alice"], denyByDefaultAdmin: false } },
    });
    bots.push(allowed);
    expect(joinedTexts(await allowed.receive({ text: "!secret" }))).toContain("granted");
  });

  it("enforces denyByDefaultAdmin without crashing when roles are provable", async () => {
    const bot = await TestBot.create({
      pluginSources: { "admin.ts": ADMIN_PLUGIN },
      configOverrides: { permissions: { adminUserIds: [], denyByDefaultAdmin: true } },
    });
    bots.push(bot);
    const reply = joinedTexts(await bot.receive({ text: "!secret" }));
    expect(reply).toContain("you don't have permission to run that command");
    expect(bot.metrics().messagesSeen).toBe(1);
  });

  it("rate limits the third command inside the window with retry seconds", async () => {
    const bot = await TestBot.create({
      pluginSources: { "ping.ts": PING_PLUGIN },
      configOverrides: { limits: partialLimits({ userCommandsPerMinute: 2 }) },
    });
    bots.push(bot);
    expect(textsOf(await bot.receive({ text: "!ping" }))).toContain("pong");
    expect(textsOf(await bot.receive({ text: "!ping" }))).toContain("pong");
    const limited = joinedTexts(await bot.receive({ text: "!ping" }));
    expect(limited).toMatch(/too fast/);
    expect(limited).toMatch(/in \d+s/);
  });

  it("opens the breaker after repeated failures and replies unavailable", async () => {
    const bot = await TestBot.create({
      pluginSources: { "flaky.ts": FLAKY_PLUGIN, "ping.ts": PING_PLUGIN },
      configOverrides: {
        limits: partialLimits({
          breakerThreshold: 2,
          breakerCooldownMs: 5000,
          breakerWindowMs: 60_000,
          handlerTimeoutMs: 8000,
        }),
      },
    });
    bots.push(bot);
    for (let index = 0; index < 2; index += 1) {
      const failed = joinedTexts(await bot.receive({ text: "!flip" }));
      expect(failed).toContain("that command failed - see bot logs.");
    }
    const open = joinedTexts(await bot.receive({ text: "!flip" }));
    expect(open).toContain("temporarily unavailable");
  }, 20_000);

  it("recovers through the half-open probe after the cooldown advances", async () => {
    const bot = await TestBot.create({
      pluginSources: { "flaky.ts": FLAKY_PLUGIN },
      configOverrides: {
        limits: partialLimits({
          breakerThreshold: 2,
          breakerCooldownMs: 5000,
          breakerWindowMs: 60_000,
          handlerTimeoutMs: 8000,
        }),
      },
    });
    bots.push(bot);
    for (let index = 0; index < 2; index += 1) {
      await bot.receive({ text: "!flip" });
    }
    await bot.advanceMs(5000);
    const healed = textsOf(await bot.receive({ text: "!flip" }));
    expect(healed).toContain("healed");
    expect(textsOf(await bot.receive({ text: "!flip" }))).toContain("healed");

    const metrics = bot.metrics();
    expect(metrics.handlerFailuresByPlugin.flaky).toBe(2);
    expect(metrics.messagesSeen).toBeGreaterThanOrEqual(4);
    expect(metrics.commandsInvoked).toBeGreaterThanOrEqual(4);
  }, 20_000);

  it("reports consistent metrics after known traffic", async () => {
    const bot = await TestBot.create({
      pluginSources: { "flaky.ts": FLAKY_PLUGIN, "ping.ts": PING_PLUGIN },
      configOverrides: {
        limits: partialLimits({
          breakerThreshold: 5,
          breakerCooldownMs: 5000,
          handlerTimeoutMs: 8000,
        }),
      },
    });
    bots.push(bot);
    expect(textsOf(await bot.receive({ text: "!ping" }))).toContain("pong");
    await bot.receive({ text: "!flip" });
    const metrics = bot.metrics();
    const sentCount = bot.mock
      .deliveries()
      .filter((delivery) => delivery.kind === "send").length;
    expect(metrics.messagesSeen).toBe(2);
    expect(metrics.messagesSeen).toBeGreaterThanOrEqual(sentCount - 1);
    expect(metrics.commandsInvoked).toBeGreaterThanOrEqual(2);
    expect(metrics.handlerFailuresByPlugin.flaky).toBe(1);
    expect(metrics.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("drains in-flight handlers during stop and records their replies", async () => {
    const bot = await TestBot.create({ pluginSources: { "ping.ts": PING_PLUGIN } });
    bots.push(bot);
    const receiving = bot.receive({ text: "!slow" });
    const summary = await bot.stop({ drainMs: 1000 });
    expect(summary).not.toBeNull();
    expect(summary?.drainedHandlers).toBeGreaterThanOrEqual(1);
    const landed = bot.mock.deliveries().some(
      (delivery) => delivery.kind === "send" && delivery.text === "slow-pong",
    );
    expect(landed).toBe(true);
    await receiving;
  });

  it("persists storage across two bots sharing one file", async () => {
    const shared = allocateHarnessPaths();
    const first = await TestBot.create({
      pluginSources: { "memo.ts": MEMO_PLUGIN },
      storageFileName: join(shared.runDir, "shared-storage.json"),
    });
    bots.push(first);
    expect(joinedTexts(await first.receive({ text: "!remember zebra runs" }))).toContain(
      "stored zebra runs",
    );
    await first.stop();

    const second = await TestBot.create({
      pluginSources: { "memo.ts": MEMO_PLUGIN },
      storageFileName: join(shared.runDir, "shared-storage.json"),
    });
    bots.push(second);
    const recalled = joinedTexts(await second.receive({ text: "!recall" }));
    expect(recalled).toContain("zebra runs");
    await second.stop();
    await removeHarnessPaths(shared);
  });

  it("hot reload swaps behaviour with identical registration counts and no dupes", async () => {
    const bot = await TestBot.create({
      pluginSources: { "word.ts": WORD_V1 },
      hotReload: true,
    });
    bots.push(bot);
    const countsBefore = JSON.stringify(bot.registryCounts());
    expect(textsOf(await bot.receive({ text: "!word" }))).toEqual(["one"]);

    writeFileSync(join(bot.harnessPaths().pluginsDir, "word.ts"), WORD_V2, "utf8");
    await bot.reloadPlugins();
    await delay(250);
    expect(JSON.stringify(bot.registryCounts())).toBe(countsBefore);

    const reloadedPage = await bot.receive({ text: "!word" });
    expect(textsOf(reloadedPage)).toEqual(["two"]);
    expect(reloadedPage.all().filter((delivery) => delivery.kind === "send")).toHaveLength(1);
  }, 20_000);

  it("records identical transcript output across two full runs", async () => {
    const runOnce = async (): Promise<string[]> => {
      const config = makeTestConfig();
      writeFileSync(join(config.plugins.dir, "ping.ts"), PING_PLUGIN, "utf8");
      const adapter = new TranscriptAdapter({
        transcriptText: "alice -> #general: !ping\n",
      });
      const runningBot = await startBot({ config, adapterInstance: adapter });
      await waitFor(() => adapter.recordedLines().length >= 1);
      const lines = [...adapter.recordedLines()];
      await runningBot.stop();
      await removeHarnessPaths(configHarnessPaths(config));
      return lines;
    };

    const firstRun = await runOnce();
    const secondRun = await runOnce();
    expect(firstRun.length).toBeGreaterThan(0);
    expect(firstRun[0]).toContain("pong");
    expect(secondRun).toEqual(firstRun);
  }, 30_000);
});
