/**
 * Directory watcher with trailing-edge debounce for plugin hot reload.
 * fs.watch delivers storms (especially on Windows); every burst for a file
 * collapses into a single onChange call 150ms after the last event.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { resolve } from "node:path";
import type { Clock, ClockTimeout } from "../clock.js";

const DEBOUNCE_MS = 150;

function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    },
  };
}

export interface DirWatcher {
  close(): void;
}

export function watchPluginsDir(
  dir: string,
  onChange: (filePath: string) => void,
  clock: Clock = systemClock(),
  onError?: (reason: string) => void,
): DirWatcher {
  const pending = new Map<string, ClockTimeout>();
  let closed = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (closed || filename === null || filename === undefined) return;
      const abs = resolve(dir, filename.toString());
      const previous = pending.get(abs);
      if (previous !== undefined) previous.cancel();
      pending.set(
        abs,
        clock.setTimeout(() => {
          pending.delete(abs);
          onChange(abs);
        }, DEBOUNCE_MS),
      );
    });
  } catch (cause) {
    onError?.(cause instanceof Error ? cause.message : String(cause));
    return { close: () => {} };
  }
  watcher.on("error", (cause) => {
    onError?.(cause instanceof Error ? cause.message : String(cause));
  });
  return {
    close(): void {
      closed = true;
      for (const timer of pending.values()) timer.cancel();
      pending.clear();
      watcher.close();
    },
  };
}
