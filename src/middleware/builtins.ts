import type { Clock } from "../clock.js";
import { RateLimitError } from "../errors.js";
import type { Logger, LogFields } from "../logging/types.js";
import type { Middleware } from "../plugin/types.js";
import type { MetricsRecorder } from "./metricsState.js";
import { dispatchTraceFor } from "./pipeline.js";

const RATE_WINDOW_MS = 60_000;

export function loggingMiddleware(logger: Logger, clock: Clock): Middleware {
  return async (message, next) => {
    const fields: LogFields = { user: message.author.username, channel: message.channelId };
    if (message.threadId !== undefined) fields.threadId = message.threadId;
    logger.debug("message received", fields);
    const startedAtMs = clock.now();
    try {
      await next();
      const terminalReached = dispatchTraceFor(message)?.terminalReached ?? true;
      logger.debug("message processed", {
        outcome: terminalReached ? "completed" : "short-circuited",
        durationMs: clock.now() - startedAtMs,
      });
    } catch (error: unknown) {
      logger.debug("message processed", {
        outcome: "failed",
        durationMs: clock.now() - startedAtMs,
      });
      throw error;
    }
  };
}

export interface RateLimitOptions {
  perMinute: number;
  clock: Clock;
}

export function rateLimitMiddleware(options: RateLimitOptions): Middleware {
  const windows = new Map<string, number[]>();
  return (message, next) => {
    const now = options.clock.now();
    const cutoff = now - RATE_WINDOW_MS;
    for (const [userId, stamps] of windows) {
      const kept = stamps.filter((at) => at > cutoff);
      if (kept.length === 0) windows.delete(userId);
      else if (kept.length !== stamps.length) windows.set(userId, kept);
    }
    const userId = message.author.id;
    const current = windows.get(userId) ?? [];
    if (current.length >= options.perMinute) {
      const oldestKept = current[0];
      const retryAtMs = (oldestKept ?? now) + RATE_WINDOW_MS;
      throw new RateLimitError(Math.ceil((retryAtMs - now) / 1000));
    }
    current.push(now);
    windows.set(userId, current);
    return next();
  };
}

export function metricsMiddleware(recorder: MetricsRecorder): Middleware {
  return async (_message, next) => {
    recorder.recordMessage();
    await next();
  };
}
