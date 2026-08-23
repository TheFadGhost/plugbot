import type { Clock, ClockTimeout } from "../../clock.js";

const MS_PER_SECOND = 1000;

interface WaitingTake {
  n: number;
  resolve: () => void;
}

/**
 * Refilling token bucket over an injected clock. take() never busy-waits;
 * a refill check is scheduled for the moment the head of the FIFO queue can
 * be satisfied.
 */
export class TokenBucket {
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly clock: Clock;
  private tokens: number;
  private lastRefillMs: number;
  private refillTimer: ClockTimeout | null = null;
  private readonly waiting: WaitingTake[] = [];

  constructor(ratePerSecond: number, burst: number, clock: Clock) {
    this.ratePerSecond = Math.max(0, ratePerSecond);
    this.burst = Math.max(0, burst);
    this.clock = clock;
    this.tokens = this.burst;
    this.lastRefillMs = clock.now();
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  async take(n = 1): Promise<void> {
    this.refill();
    this.drain();
    if (this.waiting.length === 0 && this.tryTake(n)) return;
    await new Promise<void>((resolve) => {
      this.waiting.push({ n, resolve });
      this.scheduleRefill();
    });
  }

  cancelPending(): void {
    if (this.refillTimer !== null) {
      this.refillTimer.cancel();
      this.refillTimer = null;
    }
    const queued = [...this.waiting];
    this.waiting.length = 0;
    for (const entry of queued) entry.resolve();
  }

  private refill(): void {
    const nowMs = this.clock.now();
    const elapsedSeconds = Math.max(0, nowMs - this.lastRefillMs) / MS_PER_SECOND;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillMs = nowMs;
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const head = this.waiting[0];
      if (!head || head.n > this.tokens) break;
      this.tokens -= head.n;
      this.waiting.shift();
      head.resolve();
    }
  }

  private scheduleRefill(): void {
    if (this.refillTimer !== null) return;
    const head = this.waiting[0];
    if (!head) return;
    const deficit = head.n - this.tokens;
    if (deficit <= 0) {
      this.drain();
      this.scheduleRefill();
      return;
    }
    if (this.ratePerSecond <= 0) return;
    const waitMs = Math.ceil((deficit / this.ratePerSecond) * MS_PER_SECOND);
    this.refillTimer = this.clock.setTimeout(() => {
      this.refillTimer = null;
      this.refill();
      this.drain();
      this.scheduleRefill();
    }, waitMs);
  }
}
