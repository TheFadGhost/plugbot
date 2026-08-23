import { afterEach, describe, expect, it } from "vitest";
import { TestBot } from "../src/testing/harness.js";
import type { TranscriptPage } from "../src/testing/harness.js";

const STEADY_PLUGIN = `// @ts-nocheck
export default {
  name: "steady",
  commands: {
    steady: {
      description: "Always answers.",
      run: (ctx) => ctx.reply("steady-ok"),
    },
  },
};
`;

const BOOM_PLUGIN = `// @ts-nocheck
export default {
  name: "boomer",
  commands: {
    boom: {
      description: "Throws every time.",
      run: () => {
        throw new Error("boom-from-plugin");
      },
    },
  },
};
`;

const HANG_PLUGIN = `// @ts-nocheck
export default {
  name: "hang",
  commands: {
    forever: {
      description: "Never resolves.",
      run: () => new Promise(() => {}),
    },
    alive: {
      description: "Proves the worker responds again.",
      run: (ctx) => ctx.reply("still-here"),
    },
  },
};
`;

const SPIN_PLUGIN = `// @ts-nocheck
export default {
  name: "spinner",
  commands: {
    spin: {
      description: "Burns cpu synchronously.",
      run: () => {
        const end = Date.now() + 1500;
        while (Date.now() < end) {}
      },
    },
  },
};
`;

function textsOf(page: TranscriptPage): string[] {
  return page.texts().map((line) => line.text);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function waitFor(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(15);
  }
}

describe("e2e isolation through startBot", () => {
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

  it("contains a throwing plugin while another plugin answers concurrently", async () => {
    const bot = await TestBot.create({
      pluginSources: { "boom.ts": BOOM_PLUGIN, "steady.ts": STEADY_PLUGIN },
    });
    bots.push(bot);
    const [boomPage, steadyPage] = await Promise.all([
      bot.receive({ text: "!boom" }),
      bot.receive({ text: "!steady" }),
    ]);
    expect(textsOf(steadyPage)).toContain("steady-ok");
    expect(joinedFailure(boomPage)).toContain("that command failed - see bot logs.");
  });

  it("terminates a hanging worker at the configured timeout and respawns lazily", async () => {
    const bot = await TestBot.create({
      pluginSources: { "hang.ts": HANG_PLUGIN },
      configOverrides: {
        limits: {
          handlerTimeoutMs: 250,
          breakerThreshold: 50,
          breakerWindowMs: 60_000,
          breakerCooldownMs: 1000,
          userCommandsPerMinute: 60,
          shutdownDrainMs: 5000,
        },
      },
    });
    bots.push(bot);
    bot.mock.simulateMessage({ username: "alice", channelId: "general", text: "!forever" });
    let landed = false;
    for (let attempt = 0; attempt < 50 && !landed; attempt += 1) {
      await bot.advanceMs(300);
      landed = bot.mock
        .deliveries()
        .some((delivery) => delivery.kind === "send" && delivery.text.includes("that command failed"));
    }
    expect(landed).toBe(true);
    bot.mock.simulateMessage({ username: "alice", channelId: "general", text: "!alive" });
    await waitFor(() =>
      bot.mock
        .deliveries()
        .some((delivery) => delivery.kind === "send" && delivery.text === "still-here"),
    );
    const summary = await bot.stop();
    expect(summary).not.toBeNull();
  });

  it("contains a synchronous cpu spin and answers healthy commands during the window", async () => {
    const bot = await TestBot.create({
      pluginSources: { "spin.ts": SPIN_PLUGIN, "steady.ts": STEADY_PLUGIN },
      configOverrides: {
        limits: {
          handlerTimeoutMs: 250,
          breakerThreshold: 50,
          breakerWindowMs: 60_000,
          breakerCooldownMs: 1000,
          userCommandsPerMinute: 60,
          shutdownDrainMs: 5000,
        },
      },
    });
    bots.push(bot);
    bot.mock.simulateMessage({ username: "alice", channelId: "general", text: "!spin" });
    await delay(80);
    const startedAt = Date.now();
    const steadyPage = await bot.receive({ text: "!steady" });
    const steadyElapsedMs = Date.now() - startedAt;
    expect(textsOf(steadyPage)).toContain("steady-ok");
    expect(steadyElapsedMs).toBeLessThan(1400);

    await bot.advanceMs(300);
    await waitFor(() =>
      bot.mock
        .deliveries()
        .some((delivery) => delivery.kind === "send" && delivery.text.includes("that command failed")),
    );

    const summary = await bot.stop();
    expect(summary).not.toBeNull();
    expect(summary?.forcedTerminations).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

function joinedFailure(page: TranscriptPage): string {
  return page.texts().map((line) => line.text).join("\n") || "";
}
