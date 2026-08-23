/**
 * Regression gate: loads every bundled example plugin through the real bot
 * against the mock adapter and exercises each headline behaviour. Exits 1
 * on any failure. Run: npm run examples
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MockAdapter } from "../src/adapter/mock.js";
import type { MockDelivery } from "../src/adapter/mock.js";
import { DEFAULT_CONFIG } from "../src/config/types.js";
import { createDefaultLogger } from "../src/logging/defaultLogger.js";
import { startBot } from "../src/runtime/bot.js";
import type { RunningBot } from "../src/runtime/types.js";
import { ManualClock } from "../src/testing/manualClock.js";

interface Check {
  plugin: string;
  label: string;
  run: (tools: BotTools) => Promise<string>;
}

interface BotTools {
  bot: RunningBot;
  mock: MockAdapter;
  clock: ManualClock;
}

const checks: Check[] = [
  {
    plugin: "ping",
    label: "!ping replies pong",
    async run({ mock }) {
      await send(mock, "alice", "!ping");
      return expectText(mock, /pong/);
    },
  },
  {
    plugin: "reminders",
    label: "!remind confirms and sweep delivers",
    async run({ mock, clock }) {
      await send(mock, "alice", "!remind 2s stretch");
      const confirmation = expectText(mock, /reminder r1 set/);
      await clock.advanceMs(16_000);
      await waitFor(() => mock.deliveries().some((d) => d.kind === "send" && d.text.includes("stretch - reminder")));
      return confirmation;
    },
  },
  {
    plugin: "poll",
    label: "poll lifecycle votes and closes",
    async run({ mock }) {
      await send(mock, "alice", '!poll start "best fruit?" apple pear');
      expectText(mock, /poll p1/);
      await send(mock, "alice", "!poll vote 1");
      await send(mock, "bob", "!poll vote 1");
      await send(mock, "carol", "!poll v 2");
      await send(mock, "alice", "!poll status");
      const status = expectText(mock, /apple \*\*2\*\*/);
      expectText(mock, /pear \*\*1\*\*/);
      await send(mock, "alice", "!poll close");
      expectText(mock, /winner: apple/);
      return status;
    },
  },
  {
    plugin: "modnotes",
    label: "modnotes gates writes and greets returning members",
    async run({ mock }) {
      mock.setRoles("u-carol", ["admin"]);
      await send(mock, "alice", "!note add bob late again");
      expectText(mock, /don't have permission/);
      await send(mock, "carol", "!note add bob warned about coffee");
      expectText(mock, /noted bob/);
      mock.simulateJoin("u-bob", "general");
      await waitFor(() =>
        mock.deliveries().some((d) => d.kind === "send" && d.text.includes("welcome back u-bob")),
      );
      return expectText(mock, /welcome back u-bob/);
    },
  },
  {
    plugin: "gatekeeper",
    label: "inline middleware counts dispatches",
    async run({ mock }) {
      await send(mock, "alice", "!mystats");
      return expectText(mock, /seen \d+ messages, avg dispatch \d+\.\dms/);
    },
  },
];

function realSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function send(mock: MockAdapter, from: string, text: string): Promise<void> {
  const before = lastSeq(mock);
  mock.simulateMessage({ username: from, channelId: "general", text });
  const deadline = Date.now() + 5000;
  let sawChange = false;
  let lastSeen = before;
  while (Date.now() < deadline) {
    await realSleep(40);
    const now = lastSeq(mock);
    if (now > before) sawChange = true;
    if (sawChange && now === lastSeen) return;
    lastSeen = now;
  }
}

function lastSeq(mock: MockAdapter): number {
  const deliveries = mock.deliveries();
  const last = deliveries[deliveries.length - 1];
  return last === undefined ? -1 : last.seq;
}

function expectText(mock: MockAdapter, pattern: RegExp): string {
  const found = mock
    .deliveries()
    .find((d): d is Extract<MockDelivery, { kind: "send" }> => d.kind === "send" && pattern.test(d.text));
  if (found === undefined) throw new Error(`expected a reply matching ${pattern}`);
  return found.text;
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await realSleep(20);
  }
  throw new Error("waitFor timed out");
}

async function main(): Promise<number> {
  const tempDir = mkdtempSync(join(tmpdir(), "plugbot-examples-"));
  let failures = 0;
  try {
    for (const check of checks) {
      const clock = new ManualClock();
      const mock = new MockAdapter({ clock });
      const config = structuredClone(DEFAULT_CONFIG);
      config.plugins.dir = resolve("src/plugins");
      config.storage.file = join(tempDir, `${check.plugin}-storage.json`);
      const logger = createDefaultLogger({ level: "error" });
      let bot: RunningBot | null = null;
      try {
        bot = await startBot({ config, adapterInstance: mock, clock, logger });
        const detail = await check.run({ bot, mock, clock });
        console.log(`PASS ${check.plugin} - ${check.label} (${detail.slice(0, 60)})`);
      } catch (cause) {
        failures += 1;
        const recent = mock
          .deliveries()
          .slice(-4)
          .map((d) => (d.kind === "send" ? d.text : d.kind));
        console.log(
          `FAIL ${check.plugin} - ${check.label}: ${cause instanceof Error ? cause.message : String(cause)} | last deliveries: ${JSON.stringify(recent)}`,
        );
      } finally {
        await bot?.stop().catch(() => {});
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? "all example plugins pass" : `${failures} example check(s) failed`);
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
