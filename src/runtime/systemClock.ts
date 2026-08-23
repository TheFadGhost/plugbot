import type { Clock } from "../clock.js";

export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout(handler, ms) {
      const timer = setTimeout(handler, ms);
      return { cancel: () => clearTimeout(timer) };
    },
  };
}
