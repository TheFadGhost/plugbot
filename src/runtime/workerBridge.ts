/**
 * Sandboxed PluginRuntime over worker_threads. Declarations cross once at
 * load; every handler body executes over a request/response postMessage
 * bridge with ctx services (store, outbound, logging, signal) supplied as
 * nested RPC. Every invocation races an injected-clock timeout; expiry
 * terminates the worker immediately and the next invocation lazily respawns.
 * See DESIGN.md section 8.
 */

import { Worker } from "node:worker_threads";
import type { OutboundApi, PluginConfigSchema, PluginStore } from "../plugin/types.js";
import type { Capabilities, TypingHandle } from "../adapter/adapter.js";
import type { SendOptions } from "../types.js";
import type { Clock, ClockTimeout } from "../clock.js";
import type { LogFields, Logger } from "../logging/types.js";
import type { EventType, Message } from "../types.js";
import { HandlerError, HandlerTimeoutError, PluginLoadError } from "../errors.js";
import { CircuitBreaker } from "./breaker.js";
import type { PluginIsolation, PluginManifest } from "./manifest.js";
import type {
  PluginRuntime,
  RuntimeEventName,
  RuntimeLimits,
  ShutdownResult,
} from "./pluginRuntime.js";

export type SerializedError = { name: string; message: string; stack?: string };

export interface WorkerInitEnv {
  pluginName: string;
  capabilities: Capabilities;
  config: Record<string, unknown>;
  nowMs: number;
  extra: Record<string, unknown>;
}

export type InvokePayload =
  | { kind: "command"; path: string[]; message: Message; args: Record<string, unknown>; rawArgs: string[] }
  | { kind: "listener"; name: string; message: Message; match: RegExpMatchArray | null }
  | { kind: "event"; name: EventType; payload: unknown }
  | { kind: "job"; name: string; scheduledFor: number };

export type HostToWorker =
  | { type: "init"; id: number; env: WorkerInitEnv }
  | { type: "invoke"; id: number; invocation: InvokePayload }
  | { type: "abort"; invocationId: number }
  | { type: "shutdown"; id: number; graceMs: number }
  | { type: "callResult"; nid: number; ok: true; payload?: unknown }
  | { type: "callResult"; nid: number; ok: false; error: SerializedError };

export type WorkerToHost =
  | { type: "manifest"; manifest: PluginManifest }
  | { type: "loadFailed"; error: SerializedError }
  | { type: "result"; id: number; ok: true; payload?: unknown }
  | { type: "result"; id: number; ok: false; error: SerializedError }
  | { type: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; fields?: LogFields }
  | { type: "call"; nid: number; channel: "store" | "outbound"; op: string; args: unknown[] };

interface InvocationLabel {
  kind: string;
  name: string;
}

interface PendingEntry {
  label: InvocationLabel;
  worker: Worker;
  resolve: (payload: unknown) => void;
  reject: (cause: unknown) => void;
}

export interface ThreadRuntimeOptions {
  pluginFile: string;
  pluginName: string;
  limits: RuntimeLimits;
  clock: Clock;
  logger: Logger;
  outbound: OutboundApi;
  store: PluginStore;
  capabilities: Capabilities;
  config: Record<string, unknown>;
  buildContextEnv?: () => Record<string, unknown>;
  finalizeConfig?: (
    schema: PluginConfigSchema | undefined,
    raw: Record<string, unknown>,
  ) => Record<string, unknown>;
}

function serializeError(cause: unknown): SerializedError {
  if (cause instanceof Error) {
    const serialized: SerializedError = { name: cause.name, message: cause.message };
    if (cause.stack !== undefined) serialized.stack = cause.stack;
    return serialized;
  }
  return { name: "Error", message: String(cause) };
}

function reviveError(serialized: SerializedError): Error {
  const revived = new Error(`${serialized.name}: ${serialized.message}`);
  revived.name = serialized.name;
  if (serialized.stack !== undefined) revived.stack = serialized.stack;
  return revived;
}

const WORKER_ENTRY_URL = new URL("./workerEntry.ts", import.meta.url);

export class ThreadPluginRuntime implements PluginRuntime {
  readonly isolation = "thread" as const;

  readonly #pluginFile: string;
  readonly #fallbackName: string;
  readonly #limits: RuntimeLimits;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #outbound: OutboundApi;
  readonly #store: PluginStore;
  readonly #capabilities: Capabilities;
  readonly #config: Record<string, unknown>;
  readonly #buildContextEnv: (() => Record<string, unknown>) | undefined;
  readonly #finalizeConfig:
    | ((schema: PluginConfigSchema | undefined, raw: Record<string, unknown>) => Record<string, unknown>)
    | undefined;

  readonly breaker: CircuitBreaker;

  #worker: Worker | null = null;
  #alive = false;
  #disposed = false;
  #gracefulShutdown = false;
  #seq = 0;
  #manifest: PluginManifest | null = null;
  #pending = new Map<number, PendingEntry>();
  #bootstrapping: Promise<void> | null = null;
  #readyByWorker = new Map<Worker, { resolve: (manifest: PluginManifest) => void; reject: (cause: unknown) => void }>();
  #nestedSeq = 0;
  #nestedCalls = new Map<number, { resolve: (payload: unknown) => void; reject: (cause: unknown) => void }>();
  #typingSeq = 0;
  #typingHandles = new Map<string, TypingHandle>();
  #cachedLoggerName: string | null = null;
  #cachedLogger: Logger | null = null;

  constructor(options: ThreadRuntimeOptions) {
    this.#pluginFile = options.pluginFile;
    this.#fallbackName = options.pluginName;
    this.#limits = options.limits;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#outbound = options.outbound;
    this.#store = options.store;
    this.#capabilities = options.capabilities;
    this.#config = options.config;
    this.#buildContextEnv = options.buildContextEnv;
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

  get pluginFile(): string {
    return this.#pluginFile;
  }

  get #pluginLogger(): Logger {
    const current = this.name;
    if (this.#cachedLoggerName !== current || this.#cachedLogger === null) {
      this.#cachedLoggerName = current;
      this.#cachedLogger = this.#logger.child(`plugin:${current}`);
    }
    return this.#cachedLogger;
  }

  async init(): Promise<void> {
    await this.#ensureReady();
  }

  invokeCommand(
    path: string[],
    message: Message,
    args: Record<string, unknown>,
    rawArgs: string[],
  ): Promise<void> {
    return this.#guardedInvoke(
      { kind: "command", name: path.join(".") },
      { kind: "command", path, message, args, rawArgs },
    );
  }

  invokeListener(name: string, message: Message, match: RegExpMatchArray | null): Promise<void> {
    return this.#guardedInvoke(
      { kind: "listener", name },
      { kind: "listener", name, message, match },
    );
  }

  invokeEvent(name: RuntimeEventName, payload: unknown): Promise<void> {
    return this.#guardedInvoke({ kind: "event", name }, { kind: "event", name, payload });
  }

  invokeJob(name: string, scheduledFor: number): Promise<void> {
    return this.#guardedInvoke({ kind: "job", name }, { kind: "job", name, scheduledFor });
  }

  abortActiveInvocations(): void {
    const worker = this.#worker;
    if (worker === null || !this.#alive) return;
    for (const [id, entry] of this.#pending) {
      if (entry.label.kind === "command" || entry.label.kind === "listener" ||
          entry.label.kind === "event" || entry.label.kind === "job") {
        worker.postMessage({ type: "abort", invocationId: id } satisfies HostToWorker);
      }
    }
  }

  async shutdown(graceMs: number): Promise<ShutdownResult> {
    const worker = this.#worker;
    if (this.#disposed || worker === null || !this.#alive) return { drained: false };
    const id = ++this.#seq;
    const drained = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        this.#pending.delete(id);
        resolve(value);
      };
      const timer: ClockTimeout = this.#clock.setTimeout(() => finish(false), Math.max(0, graceMs));
      this.#pending.set(id, {
        label: { kind: "shutdown", name: "shutdown" },
        worker,
        resolve: (payload) => {
          const drained = (payload as { drained?: boolean } | undefined)?.drained !== false;
          timer.cancel();
          finish(drained);
        },
        reject: () => {
          timer.cancel();
          finish(false);
        },
      });
      try {
        worker.postMessage({ type: "shutdown", id, graceMs } satisfies HostToWorker);
      } catch {
        timer.cancel();
        this.#pending.delete(id);
        finish(false);
      }
    });
    if (drained) {
      this.#gracefulShutdown = true;
      this.#alive = false;
    }
    return { drained };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const worker = this.#worker;
    this.#alive = false;
    this.#worker = null;
    this.#failAllPending("runtime disposed");
    if (worker !== null) await worker.terminate();
  }

  async #guardedInvoke(label: InvocationLabel, invocation: InvokePayload): Promise<void> {
    await this.#ensureReady();
    return this.breaker.guard(() => this.#invoke(label, invocation));
  }

  async #invoke(label: InvocationLabel, invocation: InvokePayload): Promise<void> {
    const worker = this.#requireLiveWorker();
    const id = ++this.#seq;
    await new Promise<void>((resolve, reject) => {
      let timer: ClockTimeout | null = null;
      const settle = (failure?: (cause: unknown) => void, cause?: unknown) => {
        this.#pending.delete(id);
        if (timer !== null) timer.cancel();
        if (failure !== undefined && cause !== undefined) failure(cause);
        else resolve(undefined);
      };
      this.#pending.set(id, {
        label,
        worker,
        resolve: () => settle(),
        reject: (cause) =>
          settle(
            (c) => reject(c instanceof HandlerTimeoutError ? c : new HandlerError(this.name, label.kind, label.name, c)),
            cause,
          ),
      });
      timer = this.#clock.setTimeout(() => {
        this.#timeoutInvocation(id, label);
        reject(new HandlerTimeoutError(this.name, label.kind, label.name, this.#limits.handlerTimeoutMs));
      }, this.#limits.handlerTimeoutMs);
      try {
        worker.postMessage({ type: "invoke", id, invocation } satisfies HostToWorker);
      } catch (cause: unknown) {
        settle(
          (c) => reject(new HandlerError(this.name, label.kind, label.name, c)),
          cause,
        );
      }
    });
  }

  #requireLiveWorker(): Worker {
    if (this.#disposed) throw new PluginLoadError(this.#pluginFile, "runtime disposed");
    const worker = this.#worker;
    if (worker === null || !this.#alive) throw new PluginLoadError(this.#pluginFile, "worker not running");
    return worker;
  }

  #timeoutInvocation(id: number, label: InvocationLabel): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    this.#pending.delete(id);
    const worker = this.#worker;
    if (worker !== null) {
      try {
        worker.postMessage({ type: "abort", invocationId: id } satisfies HostToWorker);
      } catch {
        // worker already gone; termination below settles everything
      }
    }
    this.#alive = false;
    this.#bootstrapping = null;
    if (this.#worker === entry.worker) void this.#worker.terminate();
    this.#failPendingOfWorker(entry.worker, (targetLabel) =>
      targetLabel === label
        ? new HandlerTimeoutError(this.name, label.kind, label.name, this.#limits.handlerTimeoutMs)
        : undefined,
    );
  }

  #failAllPending(reason: string): void {
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      entry.reject(new Error(reason));
    }
  }

  #failPendingOfWorker(worker: Worker, timeoutFor?: (label: InvocationLabel) => Error | undefined): void {
    for (const [id, entry] of this.#pending) {
      if (entry.worker !== worker) continue;
      this.#pending.delete(id);
      const timedOut = timeoutFor?.(entry.label);
      if (timedOut !== undefined) entry.reject(timedOut);
      else entry.reject(new HandlerError(this.name, entry.label.kind, entry.label.name, new Error("worker terminated")));
    }
  }

  async #ensureReady(): Promise<void> {
    if (this.#disposed) throw new PluginLoadError(this.#pluginFile, "runtime disposed");
    if (this.#alive && this.#manifest !== null) return;
    let bootstrap = this.#bootstrapping;
    if (bootstrap === null) {
      bootstrap = this.#bootstrap();
      this.#bootstrapping = bootstrap;
      const release = () => {
        if (this.#bootstrapping === bootstrap) this.#bootstrapping = null;
      };
      bootstrap.then(release, release);
    }
    await bootstrap;
  }

  async #bootstrap(): Promise<void> {
    const worker = this.#spawn();
    try {
      const manifest = await this.#awaitManifest(worker);
      if (this.#disposed) throw new PluginLoadError(this.#pluginFile, "runtime disposed");
      this.#manifest = manifest;
      this.breaker.rename(manifest.name);
      await this.#handshake(worker);
      this.#alive = true;
    } catch (cause: unknown) {
      if (this.#worker === worker) {
        this.#worker = null;
        this.#alive = false;
        void worker.terminate();
      }
      if (cause instanceof PluginLoadError) throw cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new PluginLoadError(this.#pluginFile, reason, cause);
    }
  }

  #awaitManifest(worker: Worker): Promise<PluginManifest> {
    return new Promise<PluginManifest>((resolve, reject) => {
      this.#readyByWorker.set(worker, { resolve, reject });
    });
  }

  #spawn(): Worker {
    const worker = new Worker(WORKER_ENTRY_URL, { workerData: { pluginFile: this.#pluginFile } });
    worker.on("message", (message: WorkerToHost) => this.#onMessage(message, worker));
    worker.on("error", (cause: Error) => {
      this.#onWorkerGone(worker, cause.message);
    });
    worker.on("exit", (code: number) => {
      this.#onWorkerGone(worker, `worker exited unexpectedly (code ${code})`);
    });
    this.#worker = worker;
    this.#alive = false;
    return worker;
  }

  #onWorkerGone(worker: Worker, reason: string): void {
    const readiness = this.#readyByWorker.get(worker);
    if (readiness !== undefined) {
      this.#readyByWorker.delete(worker);
      readiness.reject(new PluginLoadError(this.#pluginFile, reason));
    }
    if (this.#disposed) return;
    if (this.#worker === worker) {
      this.#worker = null;
      this.#alive = false;
      this.#bootstrapping = null;
    }
    this.#failPendingOfWorker(worker);
  }

  #onMessage(message: WorkerToHost, worker: Worker): void {
    switch (message.type) {
      case "manifest": {
        const readiness = this.#readyByWorker.get(worker);
        if (readiness !== undefined) {
          this.#readyByWorker.delete(worker);
          readiness.resolve(message.manifest);
        }
        break;
      }
      case "loadFailed": {
        const readiness = this.#readyByWorker.get(worker);
        if (readiness !== undefined) {
          this.#readyByWorker.delete(worker);
          readiness.reject(new PluginLoadError(this.#pluginFile, message.error.message));
        }
        break;
      }
      case "result": {
        const entry = this.#pending.get(message.id);
        if (entry === undefined) break;
        if (message.ok) entry.resolve(message.payload);
        else entry.reject(reviveError(message.error));
        break;
      }
      case "log":
        this.#pluginLogger[message.level](message.msg, message.fields ?? {});
        break;
      case "call":
        void this.#serveCall(message);
        break;
    }
  }

  async #serveCall(request: Extract<WorkerToHost, { type: "call" }>): Promise<void> {
    let payload: unknown;
    try {
      payload = await this.#executeCall(request.channel, request.op, request.args);
    } catch (cause: unknown) {
      this.#post({ type: "callResult", nid: request.nid, ok: false, error: serializeError(cause) });
      return;
    }
    this.#post({ type: "callResult", nid: request.nid, ok: true, payload });
  }

  async #executeCall(channel: "store" | "outbound", operation: string, args: unknown[]): Promise<unknown> {
    if (channel === "store") {
      switch (operation) {
        case "get":
          return await this.#store.get(args[0] as string);
        case "set":
          await this.#store.set(args[0] as string, args[1]);
          return null;
        case "delete":
          return await this.#store.delete(args[0] as string);
        case "list":
          return await this.#store.list(args[0] as string | undefined);
        case "clear":
          await this.#store.clear();
          return null;
        default:
          throw new Error(`unknown store operation "${operation}"`);
      }
    }
    switch (operation) {
      case "send":
        return await this.#outbound.send(
          args[0] as string,
          args[1] as string,
          args[2] as SendOptions | undefined,
        );
      case "editMessage":
        await this.#outbound.editMessage(args[0] as Parameters<OutboundApi["editMessage"]>[0], args[1] as string);
        return null;
      case "deleteMessage":
        await this.#outbound.deleteMessage(args[0] as Parameters<OutboundApi["deleteMessage"]>[0]);
        return null;
      case "react":
        await this.#outbound.react(args[0] as Parameters<OutboundApi["react"]>[0], args[1] as string);
        return null;
      case "startTyping": {
        const realHandle = await this.#outbound.startTyping(args[0] as string);
        const handleId = `typing-${++this.#typingSeq}`;
        this.#typingHandles.set(handleId, realHandle);
        return { handleId };
      }
      case "stopTyping": {
        const realHandle = this.#typingHandles.get(args[0] as string);
        if (realHandle !== undefined) {
          this.#typingHandles.delete(args[0] as string);
          await realHandle.stop();
        }
        return null;
      }
      case "getUser":
        return await this.#outbound.getUser(args[0] as string);
      case "getChannel":
        return await this.#outbound.getChannel(args[0] as string);
      default:
        throw new Error(`unknown outbound operation "${operation}"`);
    }
  }

  #post(message: HostToWorker): void {
    this.#worker?.postMessage(message);
  }

  #buildEnv(): WorkerInitEnv {
    const rawConfig = { ...this.#config };
    return {
      pluginName: this.name,
      capabilities: { ...this.#capabilities },
      config:
        this.#finalizeConfig !== undefined
          ? this.#finalizeConfig(this.#manifest?.configSchema, rawConfig)
          : rawConfig,
      nowMs: this.#clock.now(),
      extra: this.#buildContextEnv?.() ?? {},
    };
  }

  async #handshake(worker: Worker): Promise<void> {
    const id = ++this.#seq;
    await new Promise<void>((resolve, reject) => {
      this.#pending.set(id, {
        label: { kind: "init", name: "init" },
        worker,
        resolve: () => resolve(),
        reject,
      });
      try {
        worker.postMessage({ type: "init", id, env: this.#buildEnv() } satisfies HostToWorker);
      } catch (cause: unknown) {
        this.#pending.delete(id);
        reject(cause);
      }
    });
  }
}
