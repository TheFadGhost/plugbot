export interface ReconnectPolicyOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

const JITTER_SPAN = 0.4;
const JITTER_BASE = 0.8;

/** Exponential backoff capped at maxDelayMs, then jittered by 0.8x..1.2x. */
export function nextDelayMs(
  attempt: number,
  opts: ReconnectPolicyOptions,
  random: () => number = Math.random,
): number {
  const raw = opts.initialDelayMs * 2 ** attempt;
  const capped = Math.min(raw, opts.maxDelayMs);
  return capped * (JITTER_BASE + JITTER_SPAN * random());
}

/** Reconnects never give up; retries continue forever. */
export function shouldGiveUp(_attempt: number): boolean {
  return false;
}

export function* attemptDelaySequence(
  opts: ReconnectPolicyOptions,
  random: () => number = Math.random,
): Generator<number> {
  let attempt = 0;
  while (!shouldGiveUp(attempt)) {
    yield nextDelayMs(attempt, opts, random);
    attempt += 1;
  }
}
