import { describe, expect, it } from "vitest";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { TokenBucket } from "../src/adapter/irc/tokenBucket.js";

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
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.currentMs = targetMs;
  }
}

describe("TokenBucket", () => {
  it("allows an immediate take up to burst", () => {
    const bucket = new TokenBucket(1, 3, new ManualClock());
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("tryTake refuses multi-token asks above remaining capacity", () => {
    const bucket = new TokenBucket(1, 3, new ManualClock());
    expect(bucket.tryTake(2)).toBe(true);
    expect(bucket.tryTake(2)).toBe(false);
    expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
  });

  it("resolves take() with zero delay while tokens are available", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(1, 2, clock);
    const startedAt = clock.now();
    await bucket.take();
    expect(clock.now()).toBe(startedAt);
  });

  it("paces sustained takes at one token per interval under the manual clock", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(5, 2, clock);
    const completions: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      void bucket.take().then(() => completions.push(clock.now()));
    }
    expect(completions).toEqual([]);
    await clock.advanceMs(0);
    expect(completions.length).toBe(2);
    await clock.advanceMs(600);
    expect(completions.length).toBe(5);
    expect(completions[2]).toBe(200);
    expect(completions[3]).toBe(400);
    expect(completions[4]).toBe(600);
  });

  it("queues concurrent takes in FIFO order", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(2, 3, clock);
    expect(bucket.tryTake(3)).toBe(true);
    const order: string[] = [];
    const first = bucket.take().then(() => void order.push("first"));
    const second = bucket.take().then(() => void order.push("second"));
    const third = bucket.take().then(() => void order.push("third"));
    expect(order).toEqual([]);
    await clock.advanceMs(1600);
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("caps accumulated tokens at the burst size after idle time", async () => {
    const clock = new ManualClock();
    const bucket = new TokenBucket(5, 2, clock);
    await clock.advanceMs(10_000);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });
});
