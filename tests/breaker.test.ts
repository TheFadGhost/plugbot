import { afterEach, describe, expect, it } from "vitest";
import type { Clock, ClockTimeout } from "../src/clock.js";
import { CircuitOpenError } from "../src/errors.js";
import { CircuitBreaker } from "../src/runtime/breaker.js";

class ManualClock implements Clock {
  #now = 1_000;
  readonly #timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): ClockTimeout {
    const timer = { at: this.#now + ms, fn, cancelled: false };
    this.#timers.push(timer);
    return { cancel: () => { timer.cancelled = true; } };
  }

  advanceMs(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#now = Math.max(this.#now, due.at);
      due.cancelled = true;
      due.fn();
    }
    this.#now = target;
  }
}

function makeBreaker(clock: ManualClock, overrides?: Partial<{ threshold: number; windowMs: number; cooldownMs: number }>) {
  return new CircuitBreaker(clock, {
    pluginName: "dice",
    threshold: overrides?.threshold ?? 3,
    windowMs: overrides?.windowMs ?? 60_000,
    cooldownMs: overrides?.cooldownMs ?? 5_000,
  });
}

const failingGuard = (breaker: CircuitBreaker, message: string) =>
  expect(breaker.guard(async () => { throw new Error(message); })).rejects.toThrow(message);

describe("CircuitBreaker", () => {
  let clock: ManualClock;

  afterEach(() => {
    clock = new ManualClock();
  });

  it("opens after threshold consecutive failures within the window", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, { threshold: 3 });
    await failingGuard(breaker, "f1");
    expect(breaker.isOpen()).toBe(false);
    await failingGuard(breaker, "f2");
    expect(breaker.isOpen()).toBe(false);
    await failingGuard(breaker, "f3");
    expect(breaker.stateForTests()).toMatchObject({ state: "open", failuresInWindow: 0 });
    expect(breaker.isOpen()).toBe(true);
    await expect(
      Promise.resolve().then(() => breaker.guard(async () => "never")),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it("lets failures slide out of the window", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, { threshold: 2, windowMs: 100 });
    await failingGuard(breaker, "early");
    clock.advanceMs(150);
    await failingGuard(breaker, "later");
    expect(breaker.stateForTests()).toMatchObject({ state: "closed", failuresInWindow: 1 });
    await failingGuard(breaker, "third");
    expect(breaker.isOpen()).toBe(true);
  });

  it("moves to half-open once the cooldown elapses", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, { cooldownMs: 5_000 });
    for (let i = 0; i < 3; i += 1) await failingGuard(breaker, `f${i}`);
    expect(breaker.isOpen()).toBe(true);
    clock.advanceMs(4_999);
    expect(breaker.isOpen()).toBe(true);
    clock.advanceMs(1);
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.stateForTests().state).toBe("halfOpen");
  });

  it("closes when a half-open probe succeeds", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, {});
    for (let i = 0; i < 3; i += 1) await failingGuard(breaker, `f${i}`);
    clock.advanceMs(5_000);
    await expect(breaker.guard(async () => "ok")).resolves.toBe("ok");
    expect(breaker.stateForTests()).toEqual({ state: "closed", failuresInWindow: 0, retryAtMs: null });
  });

  it("reopens when a half-open probe fails", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, { cooldownMs: 5_000 });
    for (let i = 0; i < 3; i += 1) await failingGuard(breaker, `first-round-${i}`);
    const firstRetryAt = breaker.stateForTests().retryAtMs ?? -1;
    clock.advanceMs(5_000);
    expect(breaker.stateForTests().state).toBe("halfOpen");
    await failingGuard(breaker, "probe-failed");
    expect(breaker.isOpen()).toBe(true);
    const reopened = breaker.stateForTests();
    expect(reopened.state).toBe("open");
    expect(reopened.retryAtMs).not.toBe(firstRetryAt);
    expect(reopened.retryAtMs).toBe(6_000 + 5_000);
  });

  it("carries retryAtMs on CircuitOpenError", async () => {
    clock = new ManualClock();
    const breaker = makeBreaker(clock, { threshold: 1, cooldownMs: 7_000 });
    await failingGuard(breaker, "boom");
    const expectedRetryAt = 1_000 + 7_000;
    let caught: unknown;
    try {
      await breaker.guard(async () => "nope");
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CircuitOpenError);
    const openError = caught as CircuitOpenError;
    expect(openError.fields.plugin).toBe("dice");
    expect(openError.fields.retryAtMs).toBe(expectedRetryAt);
  });

  it("reports state transitions through onStateChange", async () => {
    clock = new ManualClock();
    const transitions: Array<[string, string]> = [];
    const breaker = new CircuitBreaker(clock, {
      pluginName: "dice",
      threshold: 1,
      windowMs: 60_000,
      cooldownMs: 2_000,
      onStateChange: (from, to) => transitions.push([from, to]),
    });
    await failingGuard(breaker, "boom");
    clock.advanceMs(2_000);
    await expect(breaker.guard(async () => "ok")).resolves.toBe("ok");
    expect(transitions).toEqual([
      ["closed", "open"],
      ["open", "halfOpen"],
      ["halfOpen", "closed"],
    ]);
  });
});
