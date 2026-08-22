/**
 * Injectable time. The scheduler, breaker windows, rate-limit windows, and
 * handler timeouts all read from a Clock so tests can advance time
 * deterministically. See DESIGN.md section 9.
 */

export interface ClockTimeout {
  cancel(): void;
}

export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): ClockTimeout;
}
