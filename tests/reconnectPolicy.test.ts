import { describe, expect, it } from "vitest";
import { attemptDelaySequence, nextDelayMs, shouldGiveUp } from "../src/adapter/irc/reconnectPolicy.js";

const OPTIONS = { initialDelayMs: 100, maxDelayMs: 500 };

describe("nextDelayMs", () => {
  it("grows exponentially at 0.8x with a deterministic zero random", () => {
    const zero = (): number => 0;
    expect(nextDelayMs(0, OPTIONS, zero)).toBeCloseTo(80);
    expect(nextDelayMs(1, OPTIONS, zero)).toBeCloseTo(160);
    expect(nextDelayMs(2, OPTIONS, zero)).toBeCloseTo(320);
  });

  it("grows exponentially at 1.2x with a deterministic one random", () => {
    const one = (): number => 1;
    expect(nextDelayMs(0, OPTIONS, one)).toBeCloseTo(120);
    expect(nextDelayMs(1, OPTIONS, one)).toBeCloseTo(240);
    expect(nextDelayMs(2, OPTIONS, one)).toBeCloseTo(480);
  });

  it("caps the exponential base at maxDelayMs before jitter", () => {
    const zero = (): number => 0;
    const one = (): number => 1;
    expect(nextDelayMs(3, OPTIONS, zero)).toBeCloseTo(400);
    expect(nextDelayMs(30, OPTIONS, zero)).toBeCloseTo(400);
    expect(nextDelayMs(30, OPTIONS, one)).toBeCloseTo(600);
  });

  it("stays within the jitter bounds for arbitrary random draws", () => {
    const epsilon = 1e-9;
    for (let seed = 0; seed <= 10; seed += 1) {
      const draw = seed / 10;
      const delay = nextDelayMs(0, OPTIONS, () => draw);
      expect(delay).toBeGreaterThanOrEqual(80 - epsilon);
      expect(delay).toBeLessThanOrEqual(120 + epsilon);
    }
  });
});

describe("shouldGiveUp", () => {
  it("never gives up", () => {
    expect(shouldGiveUp(0)).toBe(false);
    expect(shouldGiveUp(1_000_000)).toBe(false);
  });
});

describe("attemptDelaySequence", () => {
  it("yields the capped backoff ladder indefinitely", () => {
    const one = (): number => 1;
    const generator = attemptDelaySequence(OPTIONS, one);
    const drawn = [generator.next().value, generator.next().value, generator.next().value];
    expect(drawn.map((delay) => delay?.toFixed(0))).toEqual(["120", "240", "480"]);
    expect(generator.next().done).toBe(false);
  });
});
