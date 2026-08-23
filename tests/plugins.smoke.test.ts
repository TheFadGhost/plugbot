import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestBot } from "../src/testing/harness.js";

const PLUGIN_FILES = ["ping.ts", "reminders.ts", "poll.ts", "modnotes.ts", "gatekeeper.ts"];

const here = dirname(fileURLToPath(import.meta.url));

function sourceOf(fileName: string): string {
  return readFileSync(join(here, "..", "src", "plugins", fileName), "utf8");
}

function sourcesOf(names: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of names) map[name] = sourceOf(name);
  return map;
}

type Overrides = NonNullable<
  NonNullable<Parameters<typeof TestBot.create>[0]>["configOverrides"]
>;

const carolAdmin = {
  permissions: { adminUserIds: ["u-carol"] },
  adapter: { type: "mock", options: { roles: { "u-carol": ["admin"] } } },
} as unknown as Overrides;

function joinedTexts(page: { texts(): Array<{ text: string }> }): string {
  return page.texts().map((line) => line.text).join("\n");
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

describe("bundled example plugins through startBot", () => {
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

  it("ships worker-safe sources with zero runtime imports", () => {
    for (const name of PLUGIN_FILES) {
      const valueImports = [...sourceOf(name).matchAll(/^\s*import\s+(?!type\b)/gm)];
      expect(valueImports, name).toHaveLength(0);
    }
  });

  it("ping answers pong", async () => {
    const bot = await TestBot.create({ pluginSources: sourcesOf(["ping.ts"]) });
    bots.push(bot);
    expect(joinedTexts((await bot.receive({ text: "!ping" })))).toContain("pong");
  }, 20_000);

  it("reminders set, forget, list, and sweep deliver due items", async () => {
    const bot = await TestBot.create({ pluginSources: sourcesOf(["reminders.ts"]) });
    bots.push(bot);

    expect(joinedTexts((await bot.receive({ text: "!remind 10s water plants" })))).toContain(
      "reminder r1 set for 10s from now",
    );
    expect(joinedTexts((await bot.receive({ text: "!forget r1" })))).toContain("removed r1");
    expect(joinedTexts((await bot.receive({ text: "!forget r99" })))).toContain("no reminder r99");

    expect(joinedTexts((await bot.receive({ text: "!remind 10s water plants" })))).toContain(
      "reminder r2 set for 10s from now",
    );
    expect(joinedTexts((await bot.receive({ text: "!reminders" })))).toContain(
      "r2 in 10s: water plants",
    );
  }, 20_000);

  it("reminder sweep delivers due items after the interval elapses", async () => {
    const bot = await TestBot.create({ pluginSources: sourcesOf(["reminders.ts"]) });
    bots.push(bot);
    await bot.receive({ text: "!remind 10s water plants" });
    await bot.advanceMs(16000);
    await waitFor(() =>
      bot.mock
        .deliveries()
        .some(
          (delivery) =>
            delivery.kind === "send" && delivery.text === "water plants - reminder set by alice",
        ),
    );
    expect(joinedTexts(await bot.receive({ text: "!reminders" }))).toContain("no reminders");
  }, 20_000);

  it("poll runs the full lifecycle across voters", async () => {
    const bot = await TestBot.create({ pluginSources: sourcesOf(["poll.ts"]) });
    bots.push(bot);

    expect(
      joinedTexts(await bot.receive({ text: "!poll start solo vim" })),
    ).toContain("need at least two options");

    const started = joinedTexts(await bot.receive({ text: "!poll start editors vim emacs nano" }));
    expect(started).toContain("poll p1: editors");
    expect(started).toContain("1. vim");
    expect(started).toContain("2. emacs");
    expect(started).toContain("3. nano");

    await bot.receive({ text: "!poll vote 1" });
    await bot.receive({ from: "bob", text: "!poll vote 1" });
    await bot.receive({ from: "carol", text: "!poll vote 2" });

    const reactions = bot.mock.deliveries().filter(
      (delivery) => delivery.kind === "react" && delivery.emoji === "+1",
    );
    expect(reactions.length).toBeGreaterThanOrEqual(3);

    const status = joinedTexts(await bot.receive({ text: "!poll status" }));
    expect(status).toContain("vim **2**");
    expect(status).toContain("emacs **1**");
    expect(status).toContain("nano **0**");

    const closed = joinedTexts(await bot.receive({ text: "!poll close" }));
    expect(closed).toContain("closed p1 - winner: vim (2 votes)");
    expect(joinedTexts((await bot.receive({ text: "!poll vote 3" })))).toContain(
      "no open poll here",
    );
  }, 20_000);

  it("modnotes gates writes, records notes, and greets returning members", async () => {
    const bot = await TestBot.create({
      pluginSources: sourcesOf(["modnotes.ts"]),
      configOverrides: carolAdmin,
    });
    bots.push(bot);

    expect(joinedTexts((await bot.receive({ text: "!note add bob late to standup" })))).toContain(
      "don't have permission",
    );

    await bot.receive({ from: "carol", text: "!note add bob warned about coffee" });
    await bot.receive({ from: "carol", text: "!note add bob praised the demo" });

    const shown = joinedTexts(await bot.receive({ text: "!note show bob" }));
    expect(shown).toContain(": warned about coffee");
    expect(shown).toContain(": praised the demo");
    expect(joinedTexts((await bot.receive({ text: "!note show dave" })))).toContain(
      "no notes for dave",
    );
    expect(joinedTexts((await bot.receive({ text: "!note count" })))).toContain("2 notes");

    bot.mock.simulateJoin("u-bob", "general");
    await waitFor(() =>
      bot.mock.deliveries().some(
        (delivery) => delivery.kind === "send" && delivery.text.includes("welcome back u-bob"),
      ),
    );
    const greeted = bot.mock.deliveries().find(
      (delivery) => delivery.kind === "send" && delivery.text.includes("welcome back u-bob"),
    );
    expect(greeted && greeted.kind === "send" ? greeted.text : "").toBe(
      "welcome back u-bob (2 prior notes)",
    );

    bot.mock.simulateJoin("u-dave", "general");
    await delay(120);
    expect(bot.mock.deliveries().some((d) => d.kind === "send" && d.text.includes("welcome back u-dave"))).toBe(
      false,
    );
  }, 20_000);

  it("gatekeeper reports dispatch counters after traffic", async () => {
    const bot = await TestBot.create({
      pluginSources: sourcesOf(["gatekeeper.ts", "ping.ts"]),
    });
    bots.push(bot);
    expect(joinedTexts((await bot.receive({ text: "!ping" })))).toContain("pong");

    const stats = joinedTexts(await bot.receive({ text: "!mystats" }));
    expect(stats).toMatch(/^seen \d+ messages, avg dispatch \d+\.\dms \(last \d+\.\d\)$/);
  }, 20_000);

  it("subcommand alias v dispatches within its parent scope", async () => {
    const bot = await TestBot.create({ pluginSources: sourcesOf(["poll.ts"]) });
    bots.push(bot);
    await bot.receive({ text: "!poll start editors vim emacs" });
    const page = await bot.receive({ text: "!poll v 2" });
    expect(joinedTexts(page)).not.toContain("unknown command");
    expect(page.all().some((delivery) => delivery.kind === "react")).toBe(true);

    const bare = joinedTexts(await bot.receive({ text: "!v 2" }));
    expect(bare).toContain('unknown command "v"');
  }, 20_000);

  it("gatekeeper middleware counts dispatched messages", async () => {
    const bot = await TestBot.create({
      pluginSources: sourcesOf(["gatekeeper.ts", "ping.ts"]),
    });
    bots.push(bot);
    await bot.receive({ text: "!ping" });
    const stats = joinedTexts(await bot.receive({ text: "!mystats" }));
    const seenMatch = stats.match(/seen (\d+)/);
    expect(seenMatch === null ? 0 : Number(seenMatch[1])).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
