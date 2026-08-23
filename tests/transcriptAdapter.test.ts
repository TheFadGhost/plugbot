import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TranscriptAdapter } from "../src/adapter/transcript.js";
import type { AdapterHost } from "../src/adapter/adapter.js";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { CapabilityError, ConfigError } from "../src/errors.js";
import type { BotEvent, MemberJoinEvent, MessageEvent } from "../src/types.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const basicTranscript = join(repoRoot, "tests", "fixtures", "basic.transcript");
const deterministicTranscript = join(repoRoot, "tests", "fixtures", "deterministic.transcript");
const tmpDir = join(repoRoot, "tests", "tmp");
const REPLAY_EPOCH_MS = 1767225600000;

class ManualClock implements Clock {
  private currentMs = 0;
  private scheduled: Array<{ dueAt: number; fn: () => void }> = [];

  now(): number {
    return this.currentMs;
  }

  setTimeout(fn: () => void, ms: number): ClockTimeout {
    const timer = { dueAt: this.currentMs + Math.max(ms, 0), fn };
    this.scheduled.push(timer);
    return {
      cancel: () => {
        this.scheduled = this.scheduled.filter((candidate) => candidate !== timer);
      },
    };
  }

  advance(ms: number): void {
    this.currentMs += ms;
    const due = this.scheduled.filter((timer) => timer.dueAt <= this.currentMs);
    this.scheduled = this.scheduled.filter((timer) => timer.dueAt > this.currentMs);
    for (const timer of due) timer.fn();
  }
}

function captureHost(): { host: AdapterHost; events: BotEvent[] } {
  const events: BotEvent[] = [];
  return {
    events,
    host: {
      dispatch(event: BotEvent): void {
        events.push(event);
      },
    },
  };
}

function requireEvent<T extends BotEvent>(events: BotEvent[], index: number, type: T["type"]): T {
  const event = events[index];
  if (event === undefined || event.type !== type) {
    throw new Error(`expected ${String(type)} event at index ${index}, got ${String(event?.type)}`);
  }
  return event as T;
}

function channelIdOf(event: BotEvent): string {
  return event.type === "message" ? event.message.channelId : event.channelId;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("TranscriptAdapter", () => {
  it("replays the basic transcript in file order with correct channels", async () => {
    const { host, events } = captureHost();
    const adapter = new TranscriptAdapter({ transcriptFile: basicTranscript });

    await adapter.start(host);

    expect(events.map((event) => event.type)).toEqual([
      "memberJoin",
      "message",
      "message",
      "message",
      "message",
      "memberLeave",
      "message",
      "message",
      "message",
      "message",
      "message",
    ]);
    expect(events.map(channelIdOf)).toEqual([
      "general",
      "general",
      "general",
      "general",
      "general",
      "general",
      "dm:bob",
      "random",
      "random",
      "random",
      "dm:alice",
    ]);
  });

  it("assigns deterministic message ids and timestamps from the fixed epoch", async () => {
    const { host, events } = captureHost();
    const adapter = new TranscriptAdapter({ transcriptFile: basicTranscript });
    await adapter.start(host);

    const first = requireEvent<MessageEvent>(events, 1, "message");
    expect(first.message.id).toBe("t000001");
    expect(first.at).toBe(REPLAY_EPOCH_MS + 1000);

    const join = requireEvent<MemberJoinEvent>(events, 0, "memberJoin");
    expect(join.userId).toBe("u-carol");
    expect(join.at).toBe(REPLAY_EPOCH_MS);

    const dmBob = requireEvent<MessageEvent>(events, 6, "message");
    expect(dmBob.message.id).toBe("t000005");
    expect(dmBob.message.author).toEqual({ id: "u-bob", username: "bob" });
    expect(dmBob.at).toBe(REPLAY_EPOCH_MS + 6000);

    const last = requireEvent<MessageEvent>(events, 10, "message");
    expect(last.message.id).toBe("t000009");
    expect(last.at).toBe(REPLAY_EPOCH_MS + 10000);
  });

  it("auto-creates users and channels seen in the transcript and resolves roles", async () => {
    const adapter = new TranscriptAdapter({ transcriptFile: basicTranscript });
    await adapter.start(captureHost().host);

    expect(await adapter.getUser("u-carol")).toEqual({ id: "u-carol", username: "carol" });
    expect(await adapter.getUser("u-plugbot")).toEqual({
      id: "u-plugbot",
      username: "plugbot",
      isBot: true,
    });
    expect(await adapter.getChannel("general")).toEqual({ id: "general", name: "general", kind: "channel" });
    expect(await adapter.getChannel("dm:bob")).toEqual({ id: "dm:bob", name: "bob", kind: "dm" });
    expect(await adapter.getUser("u-nobody")).toBeNull();
    expect(await adapter.getChannel("nope")).toBeNull();

    expect(await adapter.resolveRoles("u-carol")).toEqual(["admin"]);
    expect(await adapter.resolveRoles("u-alice")).toEqual([]);
    expect(await adapter.resolveRoles("u-bob")).toEqual([]);
    expect(await adapter.resolveRoles("u-nobody")).toEqual([]);
  });

  it("routes direct messages to dm:<username> channels and parses mentions", async () => {
    const { host, events } = captureHost();
    const adapter = new TranscriptAdapter({ transcriptText: "carol -> @plugbot: hello there @alice\n" });
    await adapter.start(host);

    const dm = requireEvent<MessageEvent>(events, 0, "message");
    expect(dm.message.channelId).toBe("dm:carol");
    expect(dm.message.author).toEqual({ id: "u-carol", username: "carol" });
    expect(dm.message.mentions).toEqual(["u-alice"]);
    expect(await adapter.getChannel("dm:carol")).toEqual({ id: "dm:carol", name: "carol", kind: "dm" });
  });

  it("rejects unparseable transcripts naming file and one-based line number", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const badFile = join(tmpDir, "malformed.transcript");
    writeFileSync(badFile, "alice -> #general: fine\njoin without a channel here\n", "utf8");

    const fromFile = new TranscriptAdapter({ transcriptFile: badFile });
    await expect(fromFile.start(captureHost().host)).rejects.toBeInstanceOf(ConfigError);
    await expect(fromFile.start(captureHost().host)).rejects.toThrow(/malformed\.transcript/);
    await expect(fromFile.start(captureHost().host)).rejects.toThrow(/line 2/);

    const fromText = new TranscriptAdapter({ transcriptText: "nonsense here\n" });
    await expect(fromText.start(captureHost().host)).rejects.toThrow(/<transcriptText>: line 1:/);

    rmSync(badFile, { force: true });
  });

  it("rejects start when neither transcriptFile nor transcriptText is configured", async () => {
    const adapter = new TranscriptAdapter({});
    await expect(adapter.start(captureHost().host)).rejects.toBeInstanceOf(ConfigError);
    await expect(adapter.start(captureHost().host)).rejects.toThrow(/adapter\.options\.transcriptFile/);
  });

  it("replays the same transcript identically across fresh instances", async () => {
    async function replay(): Promise<Array<Record<string, unknown>>> {
      const { host, events } = captureHost();
      const adapter = new TranscriptAdapter({ transcriptFile: deterministicTranscript });
      await adapter.start(host);
      return events.map((event) =>
        event.type === "message"
          ? {
              type: event.type,
              at: event.at,
              id: event.message.id,
              channelId: event.message.channelId,
              text: event.message.text,
              authorId: event.message.author.id,
            }
          : { type: event.type, at: event.at, userId: event.userId, channelId: event.channelId },
      );
    }

    const firstRun = await replay();
    const secondRun = await replay();

    expect(firstRun).toEqual(secondRun);
    expect(firstRun).toEqual([
      {
        type: "message",
        at: REPLAY_EPOCH_MS,
        id: "t000001",
        channelId: "general",
        text: "first message of the deterministic run",
        authorId: "u-alice",
      },
      {
        type: "message",
        at: REPLAY_EPOCH_MS + 1000,
        id: "t000002",
        channelId: "general",
        text: "second message, mentioning @alice explicitly",
        authorId: "u-bob",
      },
      { type: "memberJoin", at: REPLAY_EPOCH_MS + 2000, userId: "u-carol", channelId: "general" },
      {
        type: "message",
        at: REPLAY_EPOCH_MS + 3000,
        id: "t000003",
        channelId: "dm:carol",
        text: "third, a direct message to the bot",
        authorId: "u-carol",
      },
      { type: "memberLeave", at: REPLAY_EPOCH_MS + 4000, userId: "u-carol", channelId: "general" },
    ]);
  });

  it("paces replayed entries on the injected clock and only on advance", async () => {
    const clock = new ManualClock();
    const { host, events } = captureHost();
    const adapter = new TranscriptAdapter({
      transcriptText: [
        "alice -> #general: one",
        "bob -> #general: two",
        "carol -> #general: three",
      ].join("\n"),
      paceMs: 10,
      clock,
    });

    const running = adapter.start(host);
    await settle();
    expect(events).toHaveLength(1);

    clock.advance(10);
    await settle();
    expect(events).toHaveLength(2);

    clock.advance(9);
    await settle();
    expect(events).toHaveLength(2);

    clock.advance(1);
    await settle();
    expect(events).toHaveLength(3);

    await running;
  });

  it("records outbound sends as lines and persists them to recordFile", async () => {
    mkdirSync(tmpDir, { recursive: true });
    const recordFile = join(tmpDir, "recorded.out");
    const adapter = new TranscriptAdapter({ transcriptText: "", recordFile });
    await adapter.start(captureHost().host);

    const sent = await adapter.send("general", "deploy finished");
    expect(sent).toEqual({ channelId: "general", messageId: "t000001" });

    await adapter.send("dm:carol", "quiet ping", { threadId: "t42" });

    expect(adapter.recordedLines()).toEqual([
      "plugbot -> #general: deploy finished",
      "plugbot -> #dm:carol: quiet ping [thread=t42]",
    ]);
    expect(readFileSync(recordFile, "utf8")).toBe(
      "plugbot -> #general: deploy finished\nplugbot -> #dm:carol: quiet ping [thread=t42]\n",
    );

    adapter.reset();
    expect(adapter.recordedLines()).toEqual([]);
  });

  it("declares edit, delete, react and typing unsupported per the capability matrix", async () => {
    const adapter = new TranscriptAdapter({ transcriptText: "" });
    await adapter.start(captureHost().host);

    expect(adapter.capabilities.send).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.capabilities.memberEvents).toBe(true);
    expect(adapter.capabilities.userLookup).toBe(true);
    expect(adapter.capabilities.channelLookup).toBe(true);
    expect(adapter.capabilities.roles).toBe(true);
    expect(adapter.capabilities.edit).toBe(false);
    expect(adapter.capabilities.delete).toBe(false);
    expect(adapter.capabilities.react).toBe(false);
    expect(adapter.capabilities.typing).toBe(false);

    const ref = { channelId: "general", messageId: "t000001" };
    await expect(adapter.editMessage(ref, "x")).rejects.toBeInstanceOf(CapabilityError);
    await expect(adapter.editMessage(ref, "x")).rejects.toThrow(/\bedit\b/);
    await expect(adapter.editMessage(ref, "x")).rejects.toThrow(/transcript/);
    await expect(adapter.deleteMessage(ref)).rejects.toThrow(/\bdelete\b/);
    await expect(adapter.react(ref, "eyes")).rejects.toThrow(/\breact\b/);
    await expect(adapter.startTyping("general")).rejects.toThrow(/\btyping\b/);
  });
});
