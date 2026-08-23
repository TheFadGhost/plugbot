import { describe, expect, it, vi } from "vitest";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { RateLimitError } from "../src/errors.js";
import {
  loggingMiddleware,
  metricsMiddleware,
  rateLimitMiddleware,
} from "../src/middleware/builtins.js";
import { createMetricsRecorder } from "../src/middleware/metricsState.js";
import { executePipeline } from "../src/middleware/pipeline.js";
import type { LogFields, LogLevel, LogRecord, Logger } from "../src/logging/types.js";
import type { Middleware, NextFn } from "../src/plugin/types.js";
import type { Message, User } from "../src/types.js";

class ManualClock implements Clock {
  #now = 1_000;

  now(): number {
    return this.#now;
  }

  setTimeout(_handler: () => void, _ms: number): ClockTimeout {
    throw new Error("setTimeout unused in these tests");
  }

  advanceMs(ms: number): void {
    this.#now += ms;
  }
}

function makeUser(id: string): User {
  return { id, username: id };
}

function makeMessage(author: User, threadId?: string): Message {
  const message: Message = {
    id: `msg-${author.id}`,
    text: "!ping",
    author,
    channelId: "chan-1",
    createdAt: 1_000,
    mentions: [],
  };
  if (threadId !== undefined) message.threadId = threadId;
  return message;
}

function makeLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void => {
      records.push({ time: 0, level, name: "test", msg, fields: fields ?? {} });
    };
  const logger: Logger = {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: () => logger,
  };
  return { logger, records };
}

const terminalNoop: NextFn = async () => undefined;

describe("rateLimitMiddleware", () => {
  it("admits up to perMinute then rejects with exactly computed retryAfterSec", async () => {
    const clock = new ManualClock();
    const mw = rateLimitMiddleware({ perMinute: 3, clock });
    const alice = makeUser("alice");
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();

    clock.advanceMs(20_000);
    let caught: unknown;
    try {
      await executePipeline([mw], makeMessage(alice), terminalNoop);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).fields.retryAfterSec).toBe(40);

    clock.advanceMs(30_000);
    caught = undefined;
    try {
      await executePipeline([mw], makeMessage(alice), terminalNoop);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as RateLimitError).fields.retryAfterSec).toBe(10);

    clock.advanceMs(9_000);
    caught = undefined;
    try {
      await executePipeline([mw], makeMessage(alice), terminalNoop);
    } catch (error: unknown) {
      caught = error;
    }
    expect((caught as RateLimitError).fields.retryAfterSec).toBe(1);
  });

  it("slides the window and admits again once stamps fall out of the 60_000ms window", async () => {
    const clock = new ManualClock();
    const mw = rateLimitMiddleware({ perMinute: 3, clock });
    const alice = makeUser("alice");
    for (let i = 0; i < 3; i += 1) {
      await executePipeline([mw], makeMessage(alice), terminalNoop);
    }
    clock.advanceMs(59_999);
    await expect(
      executePipeline([mw], makeMessage(alice), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);
    clock.advanceMs(1);
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(alice), terminalNoop)).resolves.toBeUndefined();
    await expect(
      executePipeline([mw], makeMessage(alice), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("keeps independent windows per user", async () => {
    const clock = new ManualClock();
    const mw = rateLimitMiddleware({ perMinute: 2, clock });
    const alice = makeUser("alice");
    const bob = makeUser("bob");
    await executePipeline([mw], makeMessage(alice), terminalNoop);
    await executePipeline([mw], makeMessage(alice), terminalNoop);
    await expect(
      executePipeline([mw], makeMessage(alice), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);
    await expect(executePipeline([mw], makeMessage(bob), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(bob), terminalNoop)).resolves.toBeUndefined();
    await expect(
      executePipeline([mw], makeMessage(bob), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("drops emptied windows so early users re-enter cleanly after time passes", async () => {
    const clock = new ManualClock();
    const mw = rateLimitMiddleware({ perMinute: 3, clock });
    const burst = makeUser("burst");
    const first = makeUser("user-0");
    for (let i = 0; i < 3; i += 1) {
      await executePipeline([mw], makeMessage(burst), terminalNoop);
    }
    await executePipeline([mw], makeMessage(first), terminalNoop);
    await expect(
      executePipeline([mw], makeMessage(burst), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);

    for (let i = 1; i < 50; i += 1) {
      clock.advanceMs(2_500);
      await expect(executePipeline([mw], makeMessage(makeUser(`user-${i}`)), terminalNoop)).resolves.toBeUndefined();
    }

    clock.advanceMs(61_000);
    await expect(executePipeline([mw], makeMessage(first), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(first), terminalNoop)).resolves.toBeUndefined();
    await expect(executePipeline([mw], makeMessage(first), terminalNoop)).resolves.toBeUndefined();
    await expect(
      executePipeline([mw], makeMessage(first), terminalNoop),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws without descending when limited", async () => {
    const clock = new ManualClock();
    const mw = rateLimitMiddleware({ perMinute: 1, clock });
    const alice = makeUser("alice");
    let descends = 0;
    const countingTerminal: NextFn = async () => {
      descends += 1;
    };
    await executePipeline([mw], makeMessage(alice), countingTerminal);
    await expect(executePipeline([mw], makeMessage(alice), countingTerminal)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(descends).toBe(1);
  });
});

describe("metricsMiddleware", () => {
  it("counts messages and successful commands", async () => {
    const clock = new ManualClock();
    const recorder = createMetricsRecorder(clock);
    await executePipeline([metricsMiddleware(recorder)], makeMessage(makeUser("u")), async () => {
      recorder.recordHandlerFailure("poll");
    });
    await executePipeline([metricsMiddleware(recorder)], makeMessage(makeUser("u")), terminalNoop);
    expect(recorder.snapshot()).toMatchObject({
      messagesSeen: 2,
      commandsInvoked: 2,
      commandsFailed: 0,
    });
  });

  it("records failed outcome on rejection, still counts, and preserves the original error", async () => {
    const clock = new ManualClock();
    const recorder = createMetricsRecorder(clock);
    const boom = new Error("handler-boom");
    await expect(
      executePipeline([metricsMiddleware(recorder)], makeMessage(makeUser("u")), async () => {
        recorder.recordHandlerFailure("dice");
        throw boom;
      }),
    ).rejects.toBe(boom);
    const snap = recorder.snapshot();
    expect(snap.messagesSeen).toBe(1);
    expect(snap.commandsInvoked).toBe(1);
    expect(snap.commandsFailed).toBe(1);
    expect(snap.handlerFailuresByPlugin).toEqual({ dice: 1 });
  });

  it("increments handlerFailuresByPlugin per plugin name with sorted keys", () => {
    const clock = new ManualClock();
    const recorder = createMetricsRecorder(clock);
    recorder.recordHandlerFailure("poll");
    recorder.recordHandlerFailure("dice");
    recorder.recordHandlerFailure("poll");
    const snap = recorder.snapshot();
    expect(Object.keys(snap.handlerFailuresByPlugin)).toEqual(["dice", "poll"]);
    expect(snap.handlerFailuresByPlugin).toEqual({ dice: 1, poll: 2 });
  });

  it("reports uptimeMs from the injected clock", () => {
    const clock = new ManualClock();
    const recorder = createMetricsRecorder(clock);
    expect(recorder.snapshot().uptimeMs).toBe(0);
    clock.advanceMs(5_000);
    expect(recorder.snapshot().uptimeMs).toBe(5_000);
  });

  it("returns isolated snapshots", () => {
    const clock = new ManualClock();
    const recorder = createMetricsRecorder(clock);
    recorder.recordMessage();
    recorder.recordCommand("failed");
    recorder.recordHandlerFailure("poll");
    const snap = recorder.snapshot();
    snap.messagesSeen = 999;
    snap.commandsInvoked = 999;
    snap.commandsFailed = 999;
    snap.uptimeMs = 999;
    snap.handlerFailuresByPlugin.poll = 999;
    snap.handlerFailuresByPlugin.extra = 1;
    const fresh = recorder.snapshot();
    expect(fresh.messagesSeen).toBe(1);
    expect(fresh.commandsInvoked).toBe(1);
    expect(fresh.commandsFailed).toBe(1);
    expect(fresh.uptimeMs).toBe(0);
    expect(fresh.handlerFailuresByPlugin).toEqual({ poll: 1 });
  });
});

describe("loggingMiddleware", () => {
  it("logs before descending with user/channel/threadId fields", async () => {
    const clock = new ManualClock();
    const { logger, records } = makeLogger();
    const mw = loggingMiddleware(logger, clock);
    await executePipeline([mw], makeMessage(makeUser("alice"), "thread-7"), terminalNoop);
    expect(records).toHaveLength(2);
    const before = records[0]!;
    expect(before.level).toBe("debug");
    expect(before.msg).toBe("message received");
    expect(before.fields.user).toBe("alice");
    expect(before.fields.channel).toBe("chan-1");
    expect(before.fields.threadId).toBe("thread-7");
  });

  it("omits threadId when absent and reports completed with duration", async () => {
    const clock = new ManualClock();
    const { logger, records } = makeLogger();
    const mw = loggingMiddleware(logger, clock);
    await executePipeline([mw], makeMessage(makeUser("bob")), async () => {
      clock.advanceMs(7);
    });
    const after = records[1]!;
    expect(after.msg).toBe("message processed");
    expect(after.fields.outcome).toBe("completed");
    expect(after.fields.durationMs).toBe(7);
    expect("threadId" in after.fields === false || after.fields.threadId === undefined).toBe(true);
    expect(records[0]!.msg).toBe("message received");
    expect(records[0]!.fields.threadId).toBeUndefined();
  });

  it("labels short-circuits when a later middleware skips the terminal", async () => {
    const clock = new ManualClock();
    const { logger, records } = makeLogger();
    const mw = loggingMiddleware(logger, clock);
    const terminal = vi.fn(async (): Promise<void> => undefined);
    const shortCircuit: Middleware = () => undefined;
    await executePipeline([mw, shortCircuit], makeMessage(makeUser("carol")), terminal);
    expect(terminal).not.toHaveBeenCalled();
    const after = records[1]!;
    expect(after.fields.outcome).toBe("short-circuited");
    expect(after.fields.durationMs).toBe(0);
  });

  it("labels failures, keeps duration, and rethrows unchanged", async () => {
    const clock = new ManualClock();
    const { logger, records } = makeLogger();
    const mw = loggingMiddleware(logger, clock);
    const boom = new Error("downstream-failure");
    await expect(
      executePipeline([mw], makeMessage(makeUser("dave")), async () => {
        clock.advanceMs(12);
        throw boom;
      }),
    ).rejects.toBe(boom);
    const after = records[1]!;
    expect(after.fields.outcome).toBe("failed");
    expect(after.fields.durationMs).toBe(12);
  });
});
