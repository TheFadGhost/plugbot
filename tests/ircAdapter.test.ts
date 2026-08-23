import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { IrcAdapter } from "../src/adapter/irc/ircAdapter.js";
import type { AdapterHost } from "../src/adapter/adapter.js";
import type { IrcAdapterOptions } from "../src/config/types.js";
import { AdapterOperationError } from "../src/errors.js";
import type { BotEvent, MessageEvent } from "../src/types.js";
import { startIrcTestServer } from "../src/testing/ircServer.js";
import type { IrcTestServer } from "../src/testing/ircServer.js";

interface ManualTask {
  atMs: number;
  fn: () => void;
  cancelled: boolean;
}

class ManualClock implements Clock {
  private currentMs = 0;
  private readonly tasks: ManualTask[] = [];

  now(): number {
    return this.currentMs;
  }

  setTimeout(fn: () => void, ms: number): ClockTimeout {
    const task: ManualTask = { atMs: this.currentMs + Math.max(0, ms), fn, cancelled: false };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  async advanceMs(stepMs: number): Promise<void> {
    const targetMs = this.currentMs + stepMs;
    for (;;) {
      const due = this.tasks
        .filter((task) => !task.cancelled && task.atMs <= targetMs)
        .sort((a, b) => a.atMs - b.atMs)[0];
      if (due === undefined) break;
      this.currentMs = Math.max(this.currentMs, due.atMs);
      due.cancelled = true;
      due.fn();
      await flush();
    }
    this.currentMs = targetMs;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function eventually(probe: () => void | Promise<void>, timeoutMs = 3000): Promise<void> {
  let lastCause: unknown = new Error("condition never held");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await probe();
      return;
    } catch (cause) {
      lastCause = cause;
    }
    if (Date.now() >= deadline) throw lastCause;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageEventWith(events: BotEvent[], text: string): MessageEvent | undefined {
  const found = events.find(
    (candidate): candidate is MessageEvent =>
      candidate.type === "message" && candidate.message.text === text,
  );
  return found;
}

function privmsgLines(server: IrcTestServer, nick: string): string[] {
  return server.linesFrom(nick).filter((line) => line.startsWith("PRIVMSG "));
}

describe("IrcAdapter", () => {
  let server: IrcTestServer;
  let adapters: IrcAdapter[] = [];

  beforeEach(async () => {
    server = await startIrcTestServer({ opsInChannel: { "#chan": ["alice"] } });
    adapters = [];
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      try {
        await adapter.stop();
      } catch {
        // best-effort teardown
      }
    }
    await server.close();
  });

  function buildAdapter(
    clock: Clock,
    overrides: Partial<IrcAdapterOptions> = {},
    random: () => number = Math.random,
  ): IrcAdapter {
    const options: IrcAdapterOptions = {
      server: "127.0.0.1",
      port: server.port,
      nick: "plugbot",
      reconnect: { initialDelayMs: 50, maxDelayMs: 1_000 },
      ...overrides,
    };
    const adapter = new IrcAdapter(options, { clock, random });
    adapters.push(adapter);
    return adapter;
  }

  it("completes the handshake: start resolves after 001 with NICK and USER observed", async () => {
    const events: BotEvent[] = [];
    const adapter = buildAdapter(new ManualClock());
    await adapter.start({ dispatch: (event) => events.push(event) }, { autoJoin: ["#chan"] });
    await eventually(() => expect(server.hasClient("plugbot")).toBe(true));
    const seen = server.linesFrom("plugbot");
    expect(seen.some((line) => /^NICK plugbot$/.test(line))).toBe(true);
    expect(seen.some((line) => /^USER \S+ 0 \* :/.test(line))).toBe(true);
    await eventually(() =>
      expect(seenOrLater(server, "plugbot", /^JOIN #chan$/)).resolves.toBeDefined(),
    );
    server.pingClient("plugbot");
    await eventually(() =>
      expect(seenOrLater(server, "plugbot", /^PONG /)).resolves.toBeDefined(),
    );
    await adapter.stop();
  });

  it("dispatches MessageEvents for channel and direct inbound PRIVMSG", async () => {
    const events: BotEvent[] = [];
    const adapter = buildAdapter(new ManualClock());
    await adapter.start({ dispatch: (event) => events.push(event) }, { autoJoin: ["#chan"] });
    await flush();
    const alice = await server.connectAs("alice");
    alice.sendLine("JOIN #chan");
    await alice.waitFor(/353 .*#chan/);
    alice.sendLine("PRIVMSG #chan :hello world");
    await eventually(() => {
      const event = messageEventWith(events, "hello world");
      expect(event?.message.channelId).toBe("#chan");
      expect(event?.message.author.id).toBe("irc:alice");
      expect(event?.message.author.username).toBe("alice");
      expect(event?.message.mentions).toEqual([]);
    });
    alice.sendLine("PRIVMSG #chan :hi there @alice and @ghost");
    await eventually(() => {
      const mentioning = messageEventWith(events, "hi there @alice and @ghost");
      expect(mentioning?.message.mentions).toEqual(["irc:alice"]);
    });
    alice.sendLine("PRIVMSG plugbot :psst");
    await eventually(() => {
      const direct = messageEventWith(events, "psst");
      expect(direct?.message.channelId).toBe("dm:alice");
    });
    await adapter.stop();
  });

  it("send emits exactly one PRIVMSG line observed verbatim by a peer", async () => {
    const events: BotEvent[] = [];
    const adapter = buildAdapter(new ManualClock());
    await adapter.start({ dispatch: (event) => events.push(event) }, { autoJoin: ["#chan"] });
    await flush();
    const alice = await server.connectAs("alice");
    alice.sendLine("JOIN #chan");
    await alice.waitFor(/353 .*#chan/);
    const ref = await adapter.send("#chan", "hello peers");
    const line = await alice.waitFor(/^:plugbot!\S+@\S+ PRIVMSG #chan :hello peers$/);
    expect(line).toContain("PRIVMSG #chan :hello peers");
    expect(ref.channelId).toBe("#chan");
    expect(ref.messageId).toMatch(/^irc-/);
    expect(privmsgLines(server, "plugbot")).toHaveLength(1);
    await expect(adapter.send("#unknown", "nope")).rejects.toBeInstanceOf(AdapterOperationError);
    await expect(adapter.send("#chan", "threaded", { threadId: "t1" })).rejects.toThrowError(
      /does not support threads/,
    );
    await adapter.stop();
  });

  it("rate limits bursts through the manual clock", async () => {
    const clock = new ManualClock();
    const events: BotEvent[] = [];
    const adapter = buildAdapter(clock, {
      autoJoin: ["#chan"],
      outboundRateLimit: { messagesPerSecond: 5, burst: 2 },
    });
    await adapter.start({ dispatch: (event) => events.push(event) }, {});
    await flush();
    await clock.advanceMs(250);
    const refs = [0, 1, 2, 3, 4].map((index) => adapter.send("#chan", `msg-${index}`));
    await flush();
    await flush();
    expect(refs[0]).toBeDefined();
    expect(privmsgLines(server, "plugbot")).toHaveLength(2);
    await clock.advanceMs(600);
    await Promise.all(refs);
    await eventually(() => expect(privmsgLines(server, "plugbot")).toHaveLength(5));
    const payloads = privmsgLines(server, "plugbot").map((line) => line.slice(line.lastIndexOf(":") + 1));
    expect(payloads).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"]);
    await adapter.stop();
  });

  it("detects channel operators from NAMES and resolves their roles", async () => {
    const events: BotEvent[] = [];
    const alice = await server.connectAs("alice");
    alice.sendLine("JOIN #chan");
    await alice.waitFor(/353 .*#chan/);
    const adapter = buildAdapter(new ManualClock());
    await adapter.start({ dispatch: (event) => events.push(event) }, { autoJoin: ["#chan"] });
    const channel = await adapter.getChannel("#chan");
    expect(channel).toEqual({ id: "#chan", name: "#chan", kind: "channel" });
    expect(await adapter.getChannel("#absent")).toBeNull();
    await eventually(async () => {
      expect(await adapter.resolveRoles("irc:alice", "#chan")).toEqual(["admin"]);
    });
    expect(await adapter.resolveRoles("irc:nobody", "#chan")).toEqual([]);
    expect(await adapter.resolveRoles("irc:alice")).toEqual([]);
    await adapter.stop();
  });

  it("rejects an in-flight send with reconnecting:true, reconnects, and rejoins", async () => {
    const clock = new ManualClock();
    const events: BotEvent[] = [];
    const adapter = buildAdapter(
      clock,
      {
        autoJoin: ["#chan"],
        outboundRateLimit: { messagesPerSecond: 1, burst: 2 },
      },
      () => 1,
    );
    await adapter.start({ dispatch: (event) => events.push(event) }, {});
    await flush();
    await adapter.send("#chan", "first");
    const queued = adapter.send("#chan", "second");
    const queuedAssertion = expect(queued).rejects.toMatchObject({
      code: "ADAPTER_OPERATION_FAILED",
      fields: expect.objectContaining({ reconnecting: true }),
    });
    server.dropClient("plugbot");
    await eventually(() => expect(server.hasClient("plugbot")).toBe(false));
    await queuedAssertion;
    await clock.advanceMs(100);
    await eventually(() => expect(server.hasClient("plugbot")).toBe(true));
    await eventually(() =>
      expect(server.linesFrom("plugbot").some((line) => /^NICK plugbot$/.test(line))).toBe(true),
    );
    await clock.advanceMs(1200);
    await eventually(() =>
      expect(seenOrLater(server, "plugbot", /^JOIN #chan$/)).resolves.toBeDefined(),
    );
    await adapter.stop();
  });

  it("stop closes the socket, fails later sends, and never reconnects afterwards", async () => {
    const clock = new ManualClock();
    const events: BotEvent[] = [];
    const adapter = buildAdapter(clock, {
      autoJoin: ["#chan"],
      outboundRateLimit: { messagesPerSecond: 10, burst: 10 },
    });
    await adapter.start({ dispatch: (event) => events.push(event) }, {});
    await flush();
    await eventually(() =>
      expect(seenOrLater(server, "plugbot", /^JOIN #chan$/)).resolves.toBeDefined(),
    );
    const connectionsBefore = server.connectionCount();
    await adapter.stop();
    await eventually(() => expect(server.hasClient("plugbot")).toBe(false));
    let failure: unknown;
    await adapter.send("#chan", "after stop").catch((cause: unknown) => {
      failure = cause;
    });
    expect(failure).toBeInstanceOf(AdapterOperationError);
    expect((failure as AdapterOperationError).fields.reconnecting).toBeUndefined();
    await clock.advanceMs(10_000_000);
    expect(server.connectionCount()).toBe(connectionsBefore);
    expect(server.hasClient("plugbot")).toBe(false);
  });
});

async function seenOrLater(
  server: IrcTestServer,
  nick: string,
  pattern: RegExp,
): Promise<string> {
  const existing = server.linesFrom(nick).find((line) => pattern.test(line));
  if (existing !== undefined) return existing;
  return await server.waitForFrom(nick, pattern, 100);
}
