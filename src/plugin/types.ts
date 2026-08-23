/**
 * The plugin authoring API. See DESIGN.md section 1 for the committed shape.
 *
 * Declaration metadata (names, schemas, schedules, patterns) crosses the
 * worker boundary once at load; handler functions stay inside the plugin's
 * own execution context. Everything declared here must therefore remain
 * structured-clone-safe.
 */

import type { Clock } from "../clock.js";
import type { Capabilities, TypingHandle } from "../adapter/adapter.js";
import type { Logger } from "../logging/types.js";
import type {
  BotEvent,
  MemberJoinEvent,
  MemberLeaveEvent,
  Message,
  MessageEvent,
  MessageRef,
  SendOptions,
  SentMessageRef,
  User,
  Channel,
} from "../types.js";

/** Outbound operations available to handlers, backed by the active adapter. */
export interface OutboundApi {
  send(channelId: string, text: string, options?: SendOptions): Promise<SentMessageRef>;
  editMessage(ref: MessageRef, text: string): Promise<void>;
  deleteMessage(ref: MessageRef): Promise<void>;
  react(ref: MessageRef, emoji: string): Promise<void>;
  startTyping(channelId: string): Promise<TypingHandle>;
  getUser(userId: string): Promise<User | null>;
  getChannel(channelId: string): Promise<Channel | null>;
}

/** Per-plugin namespaced key-value store. Cross-namespace access is unexpressable. */
export interface PluginStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Entries whose key starts with prefix, as [key, value] pairs sorted by key. */
  list(prefix?: string): Promise<Array<[string, unknown]>>;
  clear(): Promise<void>;
}

export interface PluginBaseContext {
  readonly name: string;
  readonly logger: Logger;
  readonly store: PluginStore;
  /** Validated plugin config values (see configSchema). */
  readonly config: Record<string, unknown>;
  readonly capabilities: Capabilities;
  readonly clock: Clock;
  readonly signal: AbortSignal;
}

export interface PluginContext<C extends Record<string, unknown> = Record<string, unknown>>
  extends PluginBaseContext {
  readonly config: C;
}

export type ParsedPluginConfig<S extends PluginConfigSchema> = {
  [K in keyof S & string]: InferConfigValue<NonNullable<S[K]>>;
};

export type InferConfigValue<F extends PluginConfigField> =
  F["type"] extends "string"
    ? string
    : F["type"] extends "number"
      ? number
      : F["type"] extends "boolean"
        ? boolean
        : F["type"] extends "string[]"
          ? string[]
          : unknown;

export interface CommandContext<A extends Record<string, unknown> = Record<string, unknown>>
  extends PluginBaseContext {
  readonly message: Message;
  readonly args: A;
  readonly rawArgs: string[];
  /** e.g. ["poll", "create"] */
  readonly commandPath: readonly string[];
  reply(text: string, options?: SendOptions): Promise<SentMessageRef>;
  react(emoji: string): Promise<void>;
  startTyping(): Promise<TypingHandle>;
  readonly bot: OutboundApi;
}

export interface ListenerContext extends PluginBaseContext {
  readonly message: Message;
  /** Match result when pattern is a RegExp; null for substring patterns. */
  readonly match: RegExpMatchArray | null;
  reply(text: string, options?: SendOptions): Promise<SentMessageRef>;
  react(emoji: string): Promise<void>;
  readonly bot: OutboundApi;
}

export interface JobContext extends PluginBaseContext {
  /** Intended fire time, epoch ms (useful when the clock advanced past it). */
  readonly scheduledFor: number;
  readonly bot: OutboundApi;
}

export interface EventContext<E extends BotEvent = BotEvent> extends PluginBaseContext {
  readonly event: E;
  readonly bot: OutboundApi;
}

export type ArgType = "string" | "number" | "boolean" | "duration";

export interface ArgDef {
  readonly type: ArgType;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  /** Collects all remaining positional arguments into an array of strings. */
  readonly rest?: boolean;
  readonly choices?: readonly (string | number)[];
  readonly min?: number;
  readonly max?: number;
}

export type ArgsSchema = Readonly<Record<string, ArgDef>>;

export type InferArgValue<A extends ArgDef> =
  A["type"] extends "number"
    ? number
    : A["type"] extends "duration"
      ? number
      : A["type"] extends "boolean"
        ? boolean
        : A extends { rest: true }
          ? string[]
          : string;

export type ParsedArgs<S extends ArgsSchema> = {
  [K in keyof S & string]: InferArgValue<NonNullable<S[K]>>;
};

export interface CommandDef<S extends ArgsSchema = ArgsSchema> {
  readonly description: string;
  readonly args?: S;
  readonly aliases?: readonly string[];
  readonly permission?: string;
  readonly hidden?: boolean;
  readonly subcommands?: Readonly<Record<string, CommandDef<ArgsSchema>>>;
  /** Omit on pure group commands that only route to subcommands. */
  run?(ctx: CommandContext<ParsedArgs<S>>): void | Promise<void>;
}

export interface ListenerDef {
  readonly name: string;
  readonly description?: string;
  /** String patterns match by substring; RegExp patterns match with .match(). */
  readonly pattern?: string | RegExp;
  readonly cooldownMs?: number;
  run(ctx: ListenerContext): void | Promise<void>;
}

/** Typed schedule objects; never cron strings. */
export type JobSchedule = { readonly everyMs: number } | { readonly dailyAt: string };

export interface JobDef {
  readonly name: string;
  readonly schedule: JobSchedule;
  readonly description?: string;
  run(ctx: JobContext): void | Promise<void>;
}

export interface PluginEventHandlers {
  message?(ctx: EventContext<MessageEvent>): void | Promise<void>;
  memberJoin?(ctx: EventContext<MemberJoinEvent>): void | Promise<void>;
  memberLeave?(ctx: EventContext<MemberLeaveEvent>): void | Promise<void>;
}

export type PluginConfigFieldType = "string" | "number" | "boolean" | "string[]";

export interface PluginConfigField {
  readonly type: PluginConfigFieldType;
  readonly required?: boolean;
  readonly default?: string | number | boolean | ReadonlyArray<string>;
}

export type PluginConfigSchema = Readonly<Record<string, PluginConfigField>>;

/**
 * Host-side middleware contributed by inline plugins only; sandboxed plugins
 * declaring middleware fail to load (functions cannot cross the boundary).
 */
export type NextFn = () => Promise<void>;
export type Middleware = (message: Message, next: NextFn) => Promise<void> | void;

export interface PluginSpec<S extends PluginConfigSchema = PluginConfigSchema> {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly isolation?: "thread" | "inline";
  readonly configSchema?: S;
  readonly commands?: Readonly<Record<string, CommandDef<ArgsSchema>>>;
  readonly listeners?: readonly ListenerDef[];
  readonly jobs?: readonly JobDef[];
  readonly events?: PluginEventHandlers;
  middleware?: Middleware[];
  init?(ctx: PluginContext<ParsedPluginConfig<S>>): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/**
 * Identity function. Type inference only; no side effects, ever. The
 * configSchema generic flows into init's ctx.config so declared defaults
 * and types reach the author without casts.
 */
export function definePlugin<S extends PluginConfigSchema>(spec: PluginSpec<S>): PluginSpec {
  return spec;
}
