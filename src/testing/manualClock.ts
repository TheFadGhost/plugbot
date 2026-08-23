import type { Clock, ClockTimeout } from "../clock.js";

interface TimerRecord {
  readonly id: number;
  readonly atMs: number;
  readonly handler: () => void;
  cancelled: boolean;
}

export class ManualClock implements Clock {
  readonly #queue: TimerRecord[] = [];
  #currentMs: number;
  #nextId = 0;

  constructor(startEpochMs = 1_700_000_000_000) {
    this.#currentMs = startEpochMs;
  }

  now(): number {
    return this.#currentMs;
  }

  setTimeout(handler: () => void, ms: number): ClockTimeout {
    const record: TimerRecord = {
      id: (this.#nextId += 1),
      atMs: this.#currentMs + Math.max(0, ms),
      handler,
      cancelled: false,
    };
    this.#insertOrdered(record);
    return {
      cancel: () => {
        record.cancelled = true;
      },
    };
  }

  async advanceMs(stepMs: number): Promise<void> {
    const targetMs = this.#currentMs + Math.max(0, stepMs);
    for (;;) {
      const due = this.#takeEarliestDue(targetMs);
      if (due === null) break;
      this.#currentMs = Math.max(this.#currentMs, due.atMs);
      due.cancelled = true;
      due.handler();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.#currentMs = Math.max(this.#currentMs, targetMs);
  }

  pendingCount(): number {
    this.#purgeCancelled();
    return this.#queue.length;
  }

  #insertOrdered(record: TimerRecord): void {
    let index = this.#queue.length;
    while (index > 0) {
      const prior = this.#queue[index - 1];
      if (prior === undefined) break;
      if (prior.atMs < record.atMs || (prior.atMs === record.atMs && prior.id < record.id)) break;
      index -= 1;
    }
    this.#queue.splice(index, 0, record);
  }

  #takeEarliestDue(targetMs: number): TimerRecord | null {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (head === undefined) return null;
      if (head.cancelled) {
        this.#queue.shift();
        continue;
      }
      if (head.atMs > targetMs) return null;
      this.#queue.shift();
      return head;
    }
    return null;
  }

  #purgeCancelled(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const record = this.#queue[index];
      if (record !== undefined && record.cancelled) this.#queue.splice(index, 1);
    }
  }
}
