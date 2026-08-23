/**
 * Runtime contracts shared between the bot orchestrator, the CLI, the test
 * harness, and middleware. startBot itself is implemented in bot.ts.
 */

import type { PlugbotConfig } from "../config/types.js";
import type { Adapter } from "../adapter/adapter.js";
import type { Clock } from "../clock.js";
import type { Logger } from "../logging/types.js";
import type { Middleware } from "../plugin/types.js";

export interface RegistryCountsEntry {
  plugin: string;
  commands: number;
  listeners: number;
  jobs: number;
}

export interface RegistryCounts {
  plugins: RegistryCountsEntry[];
}

export interface MetricsSnapshot {
  messagesSeen: number;
  commandsInvoked: number;
  commandsFailed: number;
  handlerFailuresByPlugin: Record<string, number>;
  uptimeMs: number;
}

export interface StopSummary {
  drainedHandlers: number;
  forcedTerminations: number;
  storageFlushed: boolean;
  elapsedMs: number;
}

export interface StartOptions {
  config: PlugbotConfig;
  /** Path the config was loaded from; used in error attribution. */
  configPath?: string;
  logger?: Logger;
  clock?: Clock;
  /** Pre-built adapter; constructed from config.adapter when omitted. */
  adapterInstance?: Adapter;
  /** Extra host-side middleware appended after the built-in pipeline. */
  extraMiddleware?: Middleware[];
  /** Watch the plugin directory and reload changed plugins (dev mode). */
  hotReload?: boolean;
  onReady?: () => void;
}

export interface RunningBot {
  readonly adapterName: string;
  /** Top-level command paths currently registered, sorted; powers CLI completion. */
  commandNames(): readonly string[];
  registryCounts(): RegistryCounts;
  metrics(): MetricsSnapshot;
  reloadPlugins(): Promise<void>;
  stop(options?: { drainMs?: number }): Promise<StopSummary>;
}
