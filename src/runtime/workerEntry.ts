/**
 * Worker bootstrap for thread-isolated plugins. Runs natively under Node's
 * type stripping, so project-local VALUE imports must go through dynamic
 * file URLs (static ".js" specifiers do not resolve to ".ts" sources and
 * static ".ts" specifiers fail tsc). Type-only imports are erased and safe.
 */

import { parentPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { PluginSpec } from "../plugin/types.js";
import type {
  HostToWorker,
  InvokePayload,
  SerializedError,
  WorkerInitEnv,
  WorkerToHost,
} from "./workerBridge.js";
import type { extractManifest as ExtractManifestFn, validateSpecShape as ValidateSpecShapeFn } from "./manifest.js";

type ManifestModule = {
  extractManifest: typeof ExtractManifestFn;
  validateSpecShape: typeof ValidateSpecShapeFn;
};

function requirePort(): MessagePort {
  const candidate = parentPort;
  if (candidate === null) throw new Error("workerEntry requires a worker thread");
  return candidate;
}

const port: MessagePort = requirePort();

const pluginFile = String((workerData as { pluginFile: string }).pluginFile);

function post(message: WorkerToHost): void {
  port.postMessage(message);
}

function serialize(cause: unknown): SerializedError {
  if (cause instanceof Error) {
    const out: SerializedError = { name: cause.name, message: cause.message };
    if (cause.stack !== undefined) out.stack = cause.stack;
    return out;
  }
  return { name: "Error", message: String(cause) };
}

async function loadManifestModule(): Promise<ManifestModule> {
  const ext = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";
  const href = new URL(`./manifest${ext}`, import.meta.url).href;
  return (await import(href)) as ManifestModule;
}

let spec: PluginSpec | null = null;
let env: WorkerInitEnv | null = null;
let callSeq = 0;
const callPending = new Map<number, { resolve: (payload: unknown) => void; reject: (cause: unknown) => void }>();
const invocationSignals = new Map<number, AbortController>();

function call(channel: "store" | "outbound", operation: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const nid = ++callSeq;
    callPending.set(nid, { resolve, reject });
    post({ type: "call", nid, channel, op: operation, args });
  });
}

function storeProxy() {
  return {
    get: <T>(key: string) => call("store", "get", [key]) as Promise<T | undefined>,
    set: <T>(key: string, value: T) => call("store", "set", [key, value]) as Promise<void>,
    delete: (key: string) => call("store", "delete", [key]) as Promise<boolean>,
    list: (prefix?: string) => call("store", "list", [prefix]) as Promise<Array<[string, unknown]>>,
    clear: () => call("store", "clear", []) as Promise<void>,
  };
}

interface TypingProxy {
  stop(): Promise<void>;
}

type SentRef = { channelId: string; messageId: string; threadId?: string };

const remoteOutbound = {
  send: (channelId: string, text: string, options?: { threadId?: string }) =>
    call("outbound", "send", [channelId, text, options]) as Promise<SentRef>,
  editMessage: (ref: MessageRefLike, text: string) => call("outbound", "editMessage", [ref, text]) as Promise<void>,
  deleteMessage: (ref: MessageRefLike) => call("outbound", "deleteMessage", [ref]) as Promise<void>,
  react: (ref: MessageRefLike, emoji: string) => call("outbound", "react", [ref, emoji]) as Promise<void>,
  startTyping: async (channelId: string): Promise<TypingProxy> => {
    const payload = (await call("outbound", "startTyping", [channelId])) as { handleId: string };
    return { stop: () => call("outbound", "stopTyping", [payload.handleId]) as Promise<void> };
  },
  getUser: (userId: string) => call("outbound", "getUser", [userId]),
  getChannel: (channelId: string) => call("outbound", "getChannel", [channelId]),
};

interface MessageRefLike {
  channelId: string;
  messageId: string;
  threadId?: string;
}

function buildBaseContext(signal: AbortSignal) {
  const currentEnv = env;
  if (currentEnv === null) throw new Error("worker not initialised");
  const loggerWrapper = {
    debug: (msg: string, fields?: Record<string, unknown>) => post({ type: "log", level: "debug", msg, fields }),
    info: (msg: string, fields?: Record<string, unknown>) => post({ type: "log", level: "info", msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => post({ type: "log", level: "warn", msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) => post({ type: "log", level: "error", msg, fields }),
    child: () => loggerWrapper,
  };
  const base = {
    name: currentEnv.pluginName,
    logger: loggerWrapper,
    store: storeProxy(),
    capabilities: currentEnv.capabilities,
    clock: { now: (): number => currentEnv.nowMs },
    signal,
    bot: remoteOutbound,
  };
  return { base };
}

function messageRefOf(message: { id: string; channelId: string; threadId?: string }): MessageRefLike {
  const ref: MessageRefLike = {
    channelId: message.channelId,
    messageId: message.id,
  };
  if (message.threadId !== undefined) ref.threadId = message.threadId;
  return ref;
}

function replyVia(message: { channelId: string; threadId?: string }, text: string, options?: { threadId?: string }) {
  const merged: { threadId?: string } = {};
  if (message.threadId !== undefined) merged.threadId = message.threadId;
  if (options?.threadId !== undefined) merged.threadId = options.threadId;
  return remoteOutbound.send(message.channelId, text, merged);
}

async function runInvocation(id: number, invocation: InvokePayload, signalController: AbortController): Promise<void> {
  try {
    if (spec === null) throw new Error("plugin spec unavailable");
    const { base } = buildBaseContext(signalController.signal);
    let handler: ((ctx: never) => void | Promise<void>) | undefined;
    const ctxExtras: Record<string, unknown> = {};
    switch (invocation.kind) {
      case "command": {
        let command: { run?: (ctx: never) => void | Promise<void>; subcommands?: Record<string, unknown> } | undefined =
          spec.commands?.[invocation.path[0] ?? ""] as
            | { run?: (ctx: never) => void | Promise<void>; subcommands?: Record<string, unknown> }
            | undefined;
        for (let depth = 1; depth < invocation.path.length && command !== undefined; depth += 1) {
          command = command.subcommands?.[invocation.path[depth] ?? ""] as typeof command;
        }
        handler = command?.run;
        Object.assign(ctxExtras, {
          message: invocation.message,
          args: invocation.args,
          rawArgs: invocation.rawArgs,
          commandPath: invocation.path,
          reply: (text: string, options?: { threadId?: string }) =>
            replyVia(invocation.message, text, options),
          react: (emoji: string) => remoteOutbound.react(messageRefOf(invocation.message), emoji),
          startTyping: () => remoteOutbound.startTyping(invocation.message.channelId),
        });
        break;
      }
      case "listener": {
        handler = (spec.listeners ?? []).find((l) => l.name === invocation.name)?.run as typeof handler;
        Object.assign(ctxExtras, {
          message: invocation.message,
          match: invocation.match,
          reply: (text: string, options?: { threadId?: string }) =>
            replyVia(invocation.message, text, options),
          react: (emoji: string) => remoteOutbound.react(messageRefOf(invocation.message), emoji),
        });
        break;
      }
      case "event": {
        handler = spec.events?.[invocation.name] as typeof handler;
        Object.assign(ctxExtras, { event: invocation.payload });
        break;
      }
      case "job": {
        handler = (spec.jobs ?? []).find((j) => j.name === invocation.name)?.run as typeof handler;
        Object.assign(ctxExtras, { scheduledFor: invocation.scheduledFor });
        break;
      }
    }
    if (typeof handler !== "function") {
      const targetName = "path" in invocation ? invocation.path.join(".") : invocation.name;
      throw new Error(`unknown ${invocation.kind} "${targetName}"`);
    }
    await handler({ ...base, ...ctxExtras } as never);
    post({ type: "result", id, ok: true });
  } catch (cause: unknown) {
    post({ type: "result", id, ok: false, error: serialize(cause) });
  } finally {
    invocationSignals.delete(id);
  }
}

async function runShutdown(id: number, graceMs: number): Promise<void> {
  let drained = true;
  try {
    if (spec?.shutdown !== undefined) {
      const timer = new Promise<never>((_, rejectTimer) => {
        setTimeout(() => rejectTimer(new Error("shutdown exceeded grace period")), Math.max(0, graceMs));
      });
      timer.catch(() => {});
      await Promise.race([Promise.resolve(spec.shutdown()), timer]);
    }
  } catch {
    drained = false;
  }
  post({ type: "result", id, ok: true, payload: { drained } });
}

port.on("message", (message: HostToWorker) => {
  switch (message.type) {
    case "init": {
      env = message.env;
      void (async () => {
        try {
          if (spec?.init !== undefined) {
            const currentEnv = env;
            const { base } = buildBaseContext(new AbortController().signal);
            await spec.init({ ...base, config: currentEnv.config } as never);
          }
          post({ type: "result", id: message.id, ok: true });
        } catch (cause: unknown) {
          post({ type: "result", id: message.id, ok: false, error: serialize(cause) });
        }
      })();
      break;
    }
    case "invoke": {
      if (env !== null) env = { ...env, nowMs: message.nowMs };
      const controller = new AbortController();
      invocationSignals.set(message.id, controller);
      void runInvocation(message.id, message.invocation, controller);
      break;
    }
    case "abort":
      invocationSignals.get(message.invocationId)?.abort();
      break;
    case "shutdown":
      void runShutdown(message.id, message.graceMs);
      break;
    case "callResult": {
      const pendingCall = callPending.get(message.nid);
      if (pendingCall === undefined) break;
      callPending.delete(message.nid);
      if (message.ok) pendingCall.resolve(message.payload);
      else {
        const failure = new Error(`${message.error.name}: ${message.error.message}`);
        failure.name = message.error.name;
        pendingCall.reject(failure);
      }
      break;
    }
  }
});

async function main(): Promise<void> {
  try {
    const { extractManifest, validateSpecShape } = await loadManifestModule();
    const imported = (await import(pathToFileURL(pluginFile).href)) as { default?: unknown };
    const check = validateSpecShape(imported.default);
    if (!check.ok) throw new Error(check.reason);
    spec = check.spec;
    post({ type: "manifest", manifest: extractManifest(spec, "thread") });
  } catch (cause: unknown) {
    post({ type: "loadFailed", error: serialize(cause) });
  }
}

void main();
