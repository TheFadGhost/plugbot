import { describe, expect, it, vi } from "vitest";
import { composePipeline, executePipeline } from "../src/middleware/pipeline.js";
import type { Middleware, NextFn } from "../src/plugin/types.js";
import type { Message } from "../src/types.js";

function makeMessage(id: string): Message {
  return {
    id,
    text: "hello",
    author: { id: `user-${id}`, username: `user-${id}` },
    channelId: "chan-1",
    createdAt: 1_000,
    mentions: [],
  };
}

function passthrough(log: string[], label: string): Middleware {
  return async (_message, next) => {
    log.push(`${label}-pre`);
    await next();
    log.push(`${label}-post`);
  };
}

describe("executePipeline", () => {
  it("runs middleware in order with terminal innermost", async () => {
    const log: string[] = [];
    const terminal: NextFn = async () => {
      log.push("terminal");
    };
    await executePipeline([passthrough(log, "m1"), passthrough(log, "m2")], makeMessage("m"), terminal);
    expect(log).toEqual(["m1-pre", "m2-pre", "terminal", "m2-post", "m1-post"]);
  });

  it("short-circuit in the middle skips terminal and later middleware but outer post still runs", async () => {
    const log: string[] = [];
    const terminal = vi.fn(async (): Promise<void> => {
      log.push("terminal");
    });
    const shortCircuit: Middleware = () => {
      log.push("m2-pre");
    };
    await executePipeline(
      [passthrough(log, "m1"), shortCircuit, passthrough(log, "m3")],
      makeMessage("m"),
      terminal,
    );
    expect(log).toEqual(["m1-pre", "m2-pre", "m1-post"]);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("accepts sync middleware that returns without calling next", async () => {
    const terminal = vi.fn(async (): Promise<void> => undefined);
    const syncShortCircuit: Middleware = () => undefined;
    await expect(executePipeline([syncShortCircuit], makeMessage("m"), terminal)).resolves.toBeUndefined();
    expect(terminal).not.toHaveBeenCalled();
  });

  it("propagates the original error instance through two layers", async () => {
    const boom = new Error("original-instance");
    const seen: unknown[] = [];
    const observer: Middleware = async (_message, next) => {
      try {
        await next();
      } catch (error: unknown) {
        seen.push(error);
        throw error;
      }
    };
    const thrower: Middleware = async () => {
      throw boom;
    };
    await expect(executePipeline([observer, thrower], makeMessage("m"), async () => undefined)).rejects.toThrow(
      "original-instance",
    );
    expect(seen).toEqual([boom]);
  });

  it("propagates rejections from the terminal chain", async () => {
    const boom = new Error("terminal-reject");
    const terminal: NextFn = async () => {
      throw boom;
    };
    await expect(executePipeline([], makeMessage("m"), terminal)).rejects.toBe(boom);
  });

  it("invokes the terminal directly with zero middleware", async () => {
    const order: string[] = [];
    const terminal = vi.fn(async (): Promise<void> => {
      order.push("terminal");
    });
    await executePipeline([], makeMessage("m"), terminal);
    expect(order).toEqual(["terminal"]);
  });
});

describe("composePipeline", () => {
  it("is equivalent to executePipeline", async () => {
    const logA: string[] = [];
    const chainA = [passthrough(logA, "m1"), passthrough(logA, "m2")];
    const terminal: NextFn = async () => {
      logA.push("terminal");
    };
    await composePipeline(chainA)(makeMessage("a"), terminal);

    const logB: string[] = [];
    const chainB = [passthrough(logB, "m1"), passthrough(logB, "m2")];
    await executePipeline(chainB, makeMessage("b"), async () => {
      logB.push("terminal");
    });
    expect(logA).toEqual(["m1-pre", "m2-pre", "terminal", "m2-post", "m1-post"]);
    expect(logB).toEqual(["m1-pre", "m2-pre", "terminal", "m2-post", "m1-post"]);
  });

  it("dispatches straight to the terminal when composed empty", async () => {
    const terminal = vi.fn(async (): Promise<void> => undefined);
    await composePipeline([])(makeMessage("m"), terminal);
    expect(terminal).toHaveBeenCalledTimes(1);
  });
});
