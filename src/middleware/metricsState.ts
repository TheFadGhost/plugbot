import type { Clock } from "../clock.js";
import type { MetricsSnapshot } from "../runtime/types.js";

export interface MetricsRecorder {
  recordMessage(): void;
  recordCommand(outcome: "ok" | "failed"): void;
  recordHandlerFailure(plugin: string): void;
  snapshot(): MetricsSnapshot;
}

export function createMetricsRecorder(clock: Clock): MetricsRecorder {
  const startNow = clock.now();
  let messagesSeen = 0;
  let commandsOk = 0;
  let commandsFailed = 0;
  const handlerFailuresByPlugin = new Map<string, number>();

  return {
    recordMessage(): void {
      messagesSeen += 1;
    },

    recordCommand(outcome: "ok" | "failed"): void {
      if (outcome === "failed") commandsFailed += 1;
      else commandsOk += 1;
    },

    recordHandlerFailure(plugin: string): void {
      handlerFailuresByPlugin.set(plugin, (handlerFailuresByPlugin.get(plugin) ?? 0) + 1);
      if (handlerFailuresByPlugin.size > 100) {
        const oldest = handlerFailuresByPlugin.keys().next();
        if (oldest.done !== true && oldest.value !== plugin) handlerFailuresByPlugin.delete(oldest.value);
      }
    },

    snapshot(): MetricsSnapshot {
      const byPlugin: Record<string, number> = {};
      for (const plugin of [...handlerFailuresByPlugin.keys()].sort()) {
        byPlugin[plugin] = handlerFailuresByPlugin.get(plugin) ?? 0;
      }
      return {
        messagesSeen,
        commandsInvoked: commandsOk + commandsFailed,
        commandsFailed,
        handlerFailuresByPlugin: byPlugin,
        uptimeMs: clock.now() - startNow,
      };
    },
  };
}
