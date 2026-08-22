/**
 * Configuration shape and defaults. Loading/validation live in
 * config/loader.ts; these types are the frozen schema.
 *
 * Environment overrides use the PLUGBOT_ prefix with a double underscore as
 * the path separator: PLUGBOT_LOGGING__LEVEL=debug sets logging.level.
 * Values are coerced against the schema; JSON is accepted for object values
 * such as adapter.options.
 */

import type { LogLevel } from "../logging/types.js";

export type AdapterType = "mock" | "transcript" | "irc";
export type LogTheme = "dark" | "light";

export interface LoggingConfig {
  level: LogLevel;
  json: boolean;
  theme: LogTheme;
}

export interface LimitsConfig {
  /** Per-handler execution timeout in milliseconds. */
  handlerTimeoutMs: number;
  /** Consecutive failures before a plugin's breaker opens. */
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
  /** Middleware rate limit: commands per user per minute. */
  userCommandsPerMinute: number;
  /** Grace period for in-flight handlers during shutdown. */
  shutdownDrainMs: number;
}

export interface PermissionsConfig {
  /** User ids always granted the "admin" role, on top of adapter roles. */
  adminUserIds: string[];
  /**
   * When true, commands declaring permission "admin" are denied unless the
   * platform can prove the role (adapter capability roles). When false they
   * are allowed with a warning when roles cannot be proven.
   */
  denyByDefaultAdmin: boolean;
}

export interface StorageConfig {
  file: string;
}

export interface CommandsConfig {
  prefix: string;
  mentionAliases: string[];
}

export interface PluginsConfig {
  dir: string;
  disabled: string[];
  isolation: "thread" | "inline";
}

export interface BotConfig {
  username: string;
}

export interface AdapterConfig {
  type: AdapterType;
  options: Record<string, unknown>;
}

/** Typed option shapes per adapter; adapters validate their own options at start. */
export interface MockAdapterOptions {
  botUserId?: string;
  channels?: Array<{ id: string; name?: string }>;
  users?: Array<{ id: string; username: string; displayName?: string }>;
  roles?: Record<string, string[]>;
}

export interface TranscriptAdapterOptions {
  transcriptFile: string;
  /** Where recorded outbound messages go; omit to discard them. */
  recordFile?: string;
  /** Delay between replayed lines in ms (0 makes tests instant). */
  paceMs?: number;
}

export interface IrcAdapterOptions {
  server: string;
  port: number;
  nick: string;
  username?: string;
  realName?: string;
  autoJoin?: string[];
  keepAliveMs?: number;
  reconnect?: { initialDelayMs: number; maxDelayMs: number };
  outboundRateLimit?: { messagesPerSecond: number; burst: number };
}

export interface PlugbotConfig {
  adapter: AdapterConfig;
  bot: BotConfig;
  plugins: PluginsConfig;
  commands: CommandsConfig;
  permissions: PermissionsConfig;
  storage: StorageConfig;
  logging: LoggingConfig;
  limits: LimitsConfig;
}

export const CONFIG_ENV_PREFIX = "PLUGBOT_";
export const CONFIG_ENV_SEPARATOR = "__";
export const DEFAULT_CONFIG_FILE = "config.json";

export const DEFAULT_CONFIG: PlugbotConfig = {
  adapter: { type: "mock", options: {} },
  bot: { username: "plugbot" },
  plugins: { dir: "plugins", disabled: [], isolation: "thread" },
  commands: { prefix: "!", mentionAliases: [] },
  permissions: { adminUserIds: [], denyByDefaultAdmin: false },
  storage: { file: "data/storage.json" },
  logging: { level: "info", json: false, theme: "dark" },
  limits: {
    handlerTimeoutMs: 5000,
    breakerThreshold: 5,
    breakerWindowMs: 60_000,
    breakerCooldownMs: 30_000,
    userCommandsPerMinute: 30,
    shutdownDrainMs: 10_000,
  },
};
