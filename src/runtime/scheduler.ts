/**
 * Job scheduler over the injected clock. One timer per plugin+job; scheduling
 * the same plugin+job again cancels the previous timer. Failing jobs never
 * kill their schedule: errors surface through onError and the next occurrence
 * is still armed. See DESIGN.md sections 1 (schedules) and 9 (virtual clock).
 */

import type { Clock, ClockTimeout } from "../clock.js";
import type { LogFields } from "../logging/types.js";
import { PluginLoadError } from "../errors.js";
import type { JobManifest } from "./manifest.js";

export interface ScheduledJob {
  plugin: string;
  manifest: JobManifest;
}

export type SchedulerErrorSink = (plugin: string, job: string, errorFields: LogFields) => void;

const MIN_INTERVAL_MS = 1000;
const DAILY_AT_PATTERN = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function nextDailyAt(nowMs: number, dailyAt: string): number {
  const matched = DAILY_AT_PATTERN.exec(dailyAt);
  if (matched === null) return Number.NaN;
  const hours = Number(matched[1]);
  const minutes = Number(matched[2]);
  const now = new Date(nowMs);
  let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0).getTime();
  if (next <= nowMs) {
    next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes, 0, 0).getTime();
  }
  return next;
}

interface ArmedJob {
  plugin: string;
  manifest: JobManifest;
  fire: (scheduledFor: number) => Promise<void>;
  at: number;
  timer: ClockTimeout;
}

export class Scheduler {
  readonly #clock: Clock;
  readonly #onError: SchedulerErrorSink;
  readonly #armed = new Map<string, ArmedJob>();
  #stopped = false;

  constructor(clock: Clock, onError: SchedulerErrorSink) {
    this.#clock = clock;
    this.#onError = onError;
  }

  schedule(job: ScheduledJob, fire: (scheduledFor: number) => Promise<void>): void {
    if (this.#stopped) return;
    const key = `${job.plugin}\u0000${job.manifest.name}`;
    const previous = this.#armed.get(key);
    if (previous !== undefined) {
      previous.timer.cancel();
      this.#armed.delete(key);
    }
    this.#arm(key, job, fire);
  }

  #arm(key: string, job: ScheduledJob, fire: (scheduledFor: number) => Promise<void>): void {
    const schedule = job.manifest.schedule;
    const now = this.#clock.now();
    let at: number;
    if ("everyMs" in schedule) {
      if (typeof schedule.everyMs !== "number" || !Number.isFinite(schedule.everyMs)) {
        throw new PluginLoadError(job.plugin, `job "${job.manifest.name}" has non-numeric everyMs`);
      }
      at = now + Math.max(MIN_INTERVAL_MS, schedule.everyMs);
    } else {
      at = nextDailyAt(now, schedule.dailyAt ?? "");
      if (Number.isNaN(at)) {
        throw new PluginLoadError(
          job.plugin,
          `job "${job.manifest.name}" has invalid dailyAt ${JSON.stringify(schedule.dailyAt)}; expected "HH:MM"`,
        );
      }
    }
    const entry: ArmedJob = {
      plugin: job.plugin,
      manifest: job.manifest,
      fire,
      at,
      timer: this.#clock.setTimeout(() => void this.#fire(key, entry), Math.max(0, at - now)),
    };
    this.#armed.set(key, entry);
  }

  async #fire(key: string, entry: ArmedJob): Promise<void> {
    if (this.#stopped || this.#armed.get(key) !== entry) return;
    this.#armed.delete(key);
    try {
      await entry.fire(entry.at);
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#onError(entry.plugin, entry.manifest.name, { message });
    }
    if (!this.#stopped) this.#arm(key, { plugin: entry.plugin, manifest: entry.manifest }, entry.fire);
  }

  stopAll(): void {
    this.#stopped = true;
    for (const entry of this.#armed.values()) entry.timer.cancel();
    this.#armed.clear();
  }

  pendingCount(): number {
    return this.#armed.size;
  }
}
