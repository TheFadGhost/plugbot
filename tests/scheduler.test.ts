import { afterEach, describe, expect, it } from "vitest";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { PluginLoadError } from "../src/errors.js";
import { Scheduler } from "../src/runtime/scheduler.js";

const flush = () => new Promise<void>((resolveFlush) => setImmediate(resolveFlush));

class ManualClock implements Clock {
  #now: number;
  readonly #timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];

  constructor(nowMs: number) {
    this.#now = nowMs;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): ClockTimeout {
    const timer = { at: this.#now + ms, fn, cancelled: false };
    this.#timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  async advanceMs(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flush();
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#now = Math.max(this.#now, due.at);
      due.cancelled = true;
      due.fn();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

describe("Scheduler", () => {
  const schedulers: Scheduler[] = [];

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.stopAll();
  });

  it("fires everyMs jobs repeatedly under clock advance", async () => {
    const clock = new ManualClock(0);
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    scheduler.schedule(
      { plugin: "poll", manifest: { name: "reminder", schedule: { everyMs: 1_000 } } },
      async (scheduledFor) => { firedAt.push(scheduledFor); },
    );
    expect(scheduler.pendingCount()).toBe(1);
    await clock.advanceMs(3_500);
    expect(firedAt).toEqual([1_000, 2_000, 3_000]);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it("clamps everyMs to a 1000ms minimum", async () => {
    const clock = new ManualClock(0);
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    scheduler.schedule(
      { plugin: "poll", manifest: { name: "fast", schedule: { everyMs: 50 } } },
      async (scheduledFor) => { firedAt.push(scheduledFor); },
    );
    await clock.advanceMs(1_050);
    expect(firedAt).toEqual([1_000]);
  });

  it("computes dailyAt across midnight in local time", async () => {
    const startOfDay = new Date(2026, 7, 22, 23, 58, 0, 0);
    const clock = new ManualClock(startOfDay.getTime());
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    scheduler.schedule(
      { plugin: "digest", manifest: { name: "post", schedule: { dailyAt: "00:05" } } },
      async (scheduledFor) => { firedAt.push(scheduledFor); },
    );
    const expectedFirst = new Date(2026, 7, 23, 0, 5, 0, 0).getTime();
    const expectedSecond = new Date(2026, 7, 24, 0, 5, 0, 0).getTime();
    await clock.advanceMs(expectedFirst - startOfDay.getTime());
    expect(firedAt).toEqual([expectedFirst]);
    await clock.advanceMs(expectedSecond - expectedFirst);
    expect(firedAt).toEqual([expectedFirst, expectedSecond]);
  });

  it("computes dailyAt later the same day when the time has not passed", async () => {
    const morning = new Date(2026, 7, 22, 8, 0, 0, 0);
    const clock = new ManualClock(morning.getTime());
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    scheduler.schedule(
      { plugin: "digest", manifest: { name: "post", schedule: { dailyAt: "09:00" } } },
      async (scheduledFor) => { firedAt.push(scheduledFor); },
    );
    await clock.advanceMs(60 * 60 * 1000);
    expect(firedAt).toEqual([new Date(2026, 7, 22, 9, 0, 0, 0).getTime()]);
  });

  it("throws PluginLoadError naming plugin and job for malformed dailyAt", () => {
    const clock = new ManualClock(0);
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    expect(() =>
      scheduler.schedule(
        { plugin: "digest", manifest: { name: "post", schedule: { dailyAt: "25:99" } } },
        async () => {},
      ),
    ).toThrowError(/digest.*post|post.*digest/);
    try {
      scheduler.schedule(
        { plugin: "digest", manifest: { name: "post", schedule: { dailyAt: "nope" } } },
        async () => {},
      );
      expect.unreachable("expected throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PluginLoadError);
      expect((error as PluginLoadError).message).toContain("digest");
      expect((error as PluginLoadError).message).toContain("post");
    }
  });

  it("cancels the previous timer when the same plugin+job reschedules", async () => {
    const clock = new ManualClock(0);
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    const jobSpec = { plugin: "poll", manifest: { name: "reminder", schedule: { everyMs: 1_000 } } };
    scheduler.schedule(jobSpec, async () => {});
    scheduler.schedule(jobSpec, async (scheduledFor) => { firedAt.push(scheduledFor); });
    expect(scheduler.pendingCount()).toBe(1);
    await clock.advanceMs(1_500);
    expect(firedAt).toEqual([1_000]);
  });

  it("stopAll cancels everything and pendingCount drains to zero", async () => {
    const clock = new ManualClock(0);
    const scheduler = new Scheduler(clock, () => {});
    schedulers.push(scheduler);
    const firedAt: number[] = [];
    scheduler.schedule(
      { plugin: "a", manifest: { name: "j1", schedule: { everyMs: 1_000 } } },
      async () => { firedAt.push(clock.now()); },
    );
    scheduler.schedule(
      { plugin: "b", manifest: { name: "j2", schedule: { dailyAt: "00:01" } } },
      async () => { firedAt.push(clock.now()); },
    );
    expect(scheduler.pendingCount()).toBe(2);
    scheduler.stopAll();
    expect(scheduler.pendingCount()).toBe(0);
    await clock.advanceMs(48 * 60 * 60 * 1000);
    expect(firedAt).toEqual([]);
  });

  it("keeps scheduling after a failing job and reports through onError", async () => {
    const clock = new ManualClock(0);
    const failures: Array<{ plugin: string; job: string; message: string }> = [];
    const scheduler = new Scheduler(clock, (plugin, job, errorFields) => {
      failures.push({ plugin, job, message: String(errorFields.message) });
    });
    schedulers.push(scheduler);
    let attempts = 0;
    scheduler.schedule(
      { plugin: "flaky", manifest: { name: "tick", schedule: { everyMs: 1_000 } } },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt dies");
      },
    );
    await clock.advanceMs(1_100);
    expect(failures).toEqual([{ plugin: "flaky", job: "tick", message: "first attempt dies" }]);
    await clock.advanceMs(1_000);
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(1);
    expect(scheduler.pendingCount()).toBe(1);
  });
});
