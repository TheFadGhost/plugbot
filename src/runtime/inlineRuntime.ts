/**
 * In-process PluginRuntime. Handlers execute directly with Promise.race
 * timeouts; a synchronous spin therefore cannot be preempted (the race only
 * resolves on the next microtask/check) - that limitation is accepted for
 * inline mode, which exists for embedding and debugging. Inline plugins may
 * contribute host-side middleware; sandboxed ones may not.
 */

import { pathToFileURL } from "node:url";
import type { ArgsSchema, CommandDef, Middleware, OutboundApi, PluginConfigSchema, PluginSpec, PluginStore } from "../plugin/types.js";
import type { Capabilities } from "../adapter/adapter.js";
import type { Clock, ClockTimeout } from "../clock.js";
import type { Logger } from "../logging/types.js";
import type { Message, SendOptions } from "../types.js";
import { HandlerError, HandlerTimeoutError, PluginLoadError } from "../errors.js";
import { CircuitBreaker } from "./breaker.js";
import { extractManifest, validateSpecShape } from "./manifest.js";
import type { PluginIsolation, PluginManifest } from "./manifest.js";
import type {
  PluginRuntime,
  RuntimeEventName,
  RuntimeLimits,
  ShutdownResult,
} from "./pluginRuntime.js";

export interface InlineRuntimeOptions {
  pluginFile: string;
  pluginName: string;
  limits: RuntimeLimits;
  clock: Clock;
  logger: Logger;
  outbound: OutboundApi;
  store: PluginStore;
  capabilities: Capabilities;
  config: Record<string, unknown>;
  finalizeConfig?: (
    schema: PluginConfigSchema | undefined,
    raw: Record<string, unknown>,
  ) => Record<string, unknown>;
}

interface BaseContextValue {
  name: string;
  logger: Logger;
  store: PluginStore;
  config: Record<string, unknown>;
  capabilities: Capabilities;
  clock: Clock;
  signal: AbortSignal;
  bot: OutboundApi;
}

export class InlinePluginRuntime implements PluginRuntime {
  readonly isolation = "inline" as const;

  readonly breaker: CircuitBreaker;

  readonly #pluginFile: string;
  readonly #fallbackName: string;
  readonly #limits: RuntimeLimits;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #outbound: OutboundApi;
  readonly #store: PluginStore;
  readonly #capabilities: Capabilities;
  readonly #config: Record<string, unknown>;
  readonly #finalizeConfig:
    | ((schema: PluginConfigSchema | undefined, raw: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  #bust = 0;

  #spec: PluginSpec | null = null;
  #manifest: PluginManifest | null = null;
  #disposed = false;

  constructor(options: InlineRuntimeOptions) {
    this.#pluginFile = options.pluginFile;
    this.#fallbackName = options.pluginName;
    this.#limits = options.limits;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#outbound = options.outbound;
    this.#store = options.store;
    this.#capabilities = options.capabilities;
    this.#config = options.config;
    this.#finalizeConfig = options.finalizeConfig;
    this.breaker = new CircuitBreaker(this.#clock, {
      pluginName: options.pluginName,
      threshold: options.limits.breakerThreshold,
      windowMs: options.limits.breakerWindowMs,
      cooldownMs: options.limits.breakerCooldownMs,
    });
  }

  get name(): string {
    return this.#manifest?.name ?? this.#fallbackName;
  }

  get manifest(): PluginManifest {
    if (this.#manifest === null) throw new Error(`plugin "${this.name}" manifest unavailable before init()`);
    return this.#manifest;
  }

  get middleware(): Middleware[] {
    const collected = this.#spec?.middleware;
    return Array.isArray(collected) ? [...collected] : [];
  }

  get pluginFile(): string {
    return this.#pluginFile;
  }

  get #pluginLogger(): Logger {
    return this.#logger.child(`plugin:${this.name}`);
  }

  async init(): Promise<void> {
    if (this.#spec !== null && this.#manifest !== null) return;
    if (this.#disposed) throw new PluginLoadError(this.#pluginFile, "runtime disposed");
    let imported: unknown;
    try {
      this.#bust += 1;
      imported = await import(`${pathToFileURL(this.#pluginFile).href}?t=${this.#bust}`);
    } catch (cause: unknown) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new PluginLoadError(this.#pluginFile, reason, cause);
    }
    const moduleObject = imported as { default?: unknown };
    const check = validateSpecShape(moduleObject.default);
    if (!check.ok) throw new PluginLoadError(this.#pluginFile, check.reason);
    this.#spec = check.spec;
    this.#manifest = extractManifest(check.spec, "inline");
    this.breaker.rename(this.#manifest.name);
    const initFn = check.spec.init;
    if (initFn !== undefined) {
      const controller = new AbortController();
      const base = this.#base(controller.signal);
      await this.#raceTimeout("init", "init", () => initFn(base as never), this.#limits.handlerTimeoutMs);
    }
  }

  #resolvedConfig(): Record<string, unknown> {
    const raw = { ...this.#config };
    if (this.#finalizeConfig === undefined) return raw;
    return this.#finalizeConfig(this.#manifest?.configSchema, raw);
  }

  invokeCommand(
    path: string[],
    message: Message,
    args: Record<string, unknown>,
    rawArgs: string[],
  ): Promise<void> {
    return this.breaker.guard(async () => {
      let command: CommandDef<ArgsSchema> | undefined = this.#requireSpec().commands?.[path[0] ?? ""];
      for (let depth = 1; depth < path.length && command !== undefined; depth += 1) {
        command = command.subcommands?.[path[depth] ?? ""];
      }
      if (command === undefined) throw new Error(`unknown command "${path.join(".")}"`);
      if (command.run === undefined) throw new Error(`command "${path.join(".")}" has no run handler`);
      const run = command.run;
      await this.#runGuarded("command", path.join("."), () =>
        run(this.#commandContext(path, message, args, rawArgs)),
      );
    });
  }

  invokeListener(name: string, message: Message, match: RegExpMatchArray | null): Promise<void> {
    return this.breaker.guard(async () => {
      const listener = (this.#requireSpec().listeners ?? []).find((entry) => entry.name === name);
      if (listener === undefined) throw new Error(`unknown listener "${name}"`);
      await this.#runGuarded("listener", name, () => listener.run(this.#listenerContext(message, match)));
    });
  }

  invokeEvent(name: RuntimeEventName, payload: unknown): Promise<void> {
    return this.breaker.guard(async () => {
      const hook = this.#requireSpec().events?.[name];
      if (hook === undefined) throw new Error(`unknown event hook "${name}"`);
      await this.#runGuarded("event", name, () => hook(this.#eventContext(payload)));
    });
  }

  invokeJob(name: string, scheduledFor: number): Promise<void> {
    return this.breaker.guard(async () => {
      const job = (this.#requireSpec().jobs ?? []).find((entry) => entry.name === name);
      if (job === undefined) throw new Error(`unknown job "${name}"`);
      await this.#runGuarded("job", name, () => job.run(this.#jobContext(scheduledFor)));
    });
  }

  async shutdown(graceMs: number): Promise<ShutdownResult> {
    const shutdownFn = this.#spec?.shutdown;
    if (shutdownFn === undefined) return { drained: true };
    try {
      await this.#raceTimeout("shutdown", "shutdown", () => shutdownFn(), graceMs);
      return { drained: true };
    } catch {
      return { drained: false };
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
  }

  #requireSpec(): PluginSpec {
    if (this.#spec === null) throw new PluginLoadError(this.#pluginFile, "runtime not initialised");
    return this.#spec;
  }

  async #runGuarded(kind: string, name: string, run: () => void | Promise<void>): Promise<void> {
    await this.#raceTimeout(kind, name, run, this.#limits.handlerTimeoutMs);
  }

  async #raceTimeout(
    kind: string,
    name: string,
    run: () => void | Promise<void>,
    timeoutMs: number,
  ): Promise<void> {
    const timerRef: { current: ClockTimeout | null } = { current: null };
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, rejectTimeout) => {
          timerRef.current = this.#clock.setTimeout(() => {
            rejectTimeout(new HandlerTimeoutError(this.name, kind, name, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } catch (cause: unknown) {
      if (cause instanceof HandlerTimeoutError) throw cause;
      throw new HandlerError(this.name, kind, name, cause);
    } finally {
      timerRef.current?.cancel();
    }
  }

  #base(signal: AbortSignal): BaseContextValue {
    return {
      name: this.name,
      logger: this.#pluginLogger,
      store: this.#store,
      config: this.#resolvedConfig(),
      capabilities: this.#capabilities,
      clock: this.#clock,
      signal,
      bot: this.#outbound,
    };
  }

  #replyVia(message: Message, text: string, options?: SendOptions): ReturnType<OutboundApi["send"]> {
    const merged: { threadId?: string } = {};
    if (message.threadId !== undefined) merged.threadId = message.threadId;
    if (options?.threadId !== undefined) merged.threadId = options.threadId;
    return this.#outbound.send(message.channelId, text, merged);
  }

  #reactVia(message: Message, emoji: string): Promise<void> {
    return this.#outbound.react({ channelId: message.channelId, messageId: message.id, threadId: message.threadId }, emoji);
  }

  #commandContext(
    path: string[],
    message: Message,
    args: Record<string, unknown>,
    rawArgs: string[],
  ): never {
    const controller = new AbortController();
    const base = this.#base(controller.signal);
    return {
      ...base,
      message,
      args,
      rawArgs,
      commandPath: path,
      reply: (text: string, options?: SendOptions) => this.#replyVia(message, text, options),
      react: (emoji: string) => this.#reactVia(message, emoji),
      startTyping: () => this.#outbound.startTyping(message.channelId),
    } as never;
  }

  #listenerContext(message: Message, match: RegExpMatchArray | null): never {
    const controller = new AbortController();
    const base = this.#base(controller.signal);
    return {
      ...base,
      message,
      match,
      reply: (text: string, options?: SendOptions) => this.#replyVia(message, text, options),
      react: (emoji: string) => this.#reactVia(message, emoji),
    } as never;
  }

  #jobContext(scheduledFor: number): never {
    const controller = new AbortController();
    const base = this.#base(controller.signal);
    return { ...base, scheduledFor } as never;
  }

  #eventContext(payload: unknown): never {
    const controller = new AbortController();
    const base = this.#base(controller.signal);
    return { ...base, event: payload } as never;
  }
}
