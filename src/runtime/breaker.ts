/**
 * Per-plugin circuit breaker. See DESIGN.md section 8: opens after N
 * consecutive handler failures inside a sliding window, cools down, then
 * admits one probe. All time reads come from the injected clock; transitions
 * are lazy so virtual clocks advance them deterministically.
 */

import type { Clock } from "../clock.js";
import { CircuitOpenError } from "../errors.js";

export type BreakerState = "closed" | "open" | "halfOpen";

export interface BreakerStateSnapshot {
  state: BreakerState;
  failuresInWindow: number;
  retryAtMs: number | null;
}

export interface BreakerChangeFields {
  failuresInWindow: number;
  retryAtMs: number | null;
}

export interface CircuitBreakerOptions {
  pluginName: string;
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  onStateChange?: (from: BreakerState, to: BreakerState, fields: BreakerChangeFields) => void;
}

export class CircuitBreaker {
  readonly #clock: Clock;
  #pluginName: string;
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #cooldownMs: number;
  #onStateChange: ((from: BreakerState, to: BreakerState, fields: BreakerChangeFields) => void) | undefined;

  #state: BreakerState = "closed";
  #failures: number[] = [];
  #retryAtMs: number | null = null;

  constructor(clock: Clock, options: CircuitBreakerOptions) {
    this.#clock = clock;
    this.#pluginName = options.pluginName;
    this.#threshold = Math.max(1, options.threshold);
    this.#windowMs = options.windowMs;
    this.#cooldownMs = options.cooldownMs;
    this.#onStateChange = options.onStateChange;
  }

  set onStateChange(
    callback: ((from: BreakerState, to: BreakerState, fields: BreakerChangeFields) => void) | undefined,
  ) {
    this.#onStateChange = callback;
  }

  rename(pluginName: string): void {
    this.#pluginName = pluginName;
  }

  #transition(to: BreakerState): void {
    const from = this.#state;
    if (from === to) return;
    this.#state = to;
    this.#onStateChange?.(from, to, {
      failuresInWindow: this.#failures.length,
      retryAtMs: this.#retryAtMs,
    });
  }

  #pruneWindow(): void {
    const horizon = this.#clock.now() - this.#windowMs;
    this.#failures = this.#failures.filter((at) => at > horizon);
  }

  refresh(): void {
    if (this.#state === "open") {
      const now = this.#clock.now();
      if (this.#retryAtMs !== null && now >= this.#retryAtMs) {
        this.#retryAtMs = null;
        this.#transition("halfOpen");
      }
    }
  }

  isOpen(): boolean {
    this.refresh();
    return this.#state === "open";
  }

  recordSuccess(): void {
    this.refresh();
    this.#failures = [];
    this.#retryAtMs = null;
    if (this.#state !== "closed") this.#transition("closed");
  }

  recordFailure(): void {
    this.refresh();
    if (this.#state === "halfOpen") {
      this.#open();
      return;
    }
    if (this.#state === "open") return;
    this.#failures.push(this.#clock.now());
    this.#pruneWindow();
    if (this.#failures.length >= this.#threshold) this.#open();
  }

  #open(): void {
    this.#failures = [];
    this.#retryAtMs = this.#clock.now() + this.#cooldownMs;
    this.#transition("open");
  }

  guard<T>(fn: () => Promise<T>): Promise<T> {
    this.refresh();
    if (this.#state === "open") {
      throw new CircuitOpenError(this.#pluginName, this.#retryAtMs ?? this.#clock.now());
    }
    return fn().then(
      (value) => {
        this.recordSuccess();
        return value;
      },
      (cause: unknown) => {
        this.recordFailure();
        throw cause;
      },
    );
  }

  stateForTests(): BreakerStateSnapshot {
    this.refresh();
    return {
      state: this.#state,
      failuresInWindow: this.#failures.length,
      retryAtMs: this.#retryAtMs,
    };
  }
}
