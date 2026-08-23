/**
 * Public entry. Plugin authors import { definePlugin } and types from here.
 */

export type {
  ArgDef,
  ArgsSchema,
  CommandContext,
  CommandDef,
  EventContext,
  InferArgValue,
  InferConfigValue,
  JobContext,
  JobDef,
  JobSchedule,
  ListenerContext,
  ListenerDef,
  Middleware,
  NextFn,
  OutboundApi,
  ParsedArgs,
  ParsedPluginConfig,
  PluginConfigField,
  PluginConfigSchema,
  PluginContext,
  PluginEventHandlers,
  PluginSpec,
  PluginStore,
} from "./plugin/types.js";
export { definePlugin } from "./plugin/types.js";

export type {
  AdapterStartOptions,
  Adapter,
  AdapterHost,
  Capabilities,
  TypingHandle,
} from "./adapter/adapter.js";
export { BaseAdapter } from "./adapter/adapter.js";

export type {
  BotEvent,
  Channel,
  ChannelKind,
  EventType,
  Message,
  MessageEvent,
  MessageRef,
  MemberJoinEvent,
  MemberLeaveEvent,
  Role,
  SendOptions,
  SentMessageRef,
  SentMessageRef as SentMessage,
  User,
} from "./types.js";
export { EVENT_TYPES } from "./types.js";

export type { Clock, ClockTimeout } from "./clock.js";

export type { LogFields, LogLevel, Logger, LogRecord, LogSink } from "./logging/types.js";

export {
  ArgumentValidationError,
  AdapterOperationError,
  CapabilityError,
  CircuitOpenError,
  CommandUnknownError,
  ConfigError,
  type ConfigViolation,
  HandlerError,
  HandlerTimeoutError,
  PermissionDeniedError,
  PlugbotError,
  type PlugbotErrorCode,
  PluginLoadError,
  RateLimitError,
  StorageError,
} from "./errors.js";

export type {
  AdapterType,
  CommandsConfig,
  IrcAdapterOptions,
  LimitsConfig,
  LoggingConfig,
  LogTheme,
  MockAdapterOptions,
  PermissionsConfig,
  PlugbotConfig,
  PluginsConfig,
  StorageConfig,
  TranscriptAdapterOptions,
} from "./config/types.js";
