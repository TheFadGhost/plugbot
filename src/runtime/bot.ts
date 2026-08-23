import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Adapter } from "../adapter/adapter.js";
import { MockAdapter } from "../adapter/mock.js";
import { TranscriptAdapter } from "../adapter/transcript.js";
import { IrcAdapter } from "../adapter/irc/ircAdapter.js";
import type {
  IrcAdapterOptions,
  MockAdapterOptions,
  PlugbotConfig,
  TranscriptAdapterOptions,
} from "../config/types.js";
import type { Clock } from "../clock.js";
import { CircuitOpenError, HandlerError, HandlerTimeoutError } from "../errors.js";
import { createDefaultLogger } from "../logging/defaultLogger.js";
import type { Logger } from "../logging/types.js";
import { createAuthorizer } from "../middleware/authorizer.js";
import { loggingMiddleware, metricsMiddleware, rateLimitMiddleware } from "../middleware/builtins.js";
import { createMetricsRecorder } from "../middleware/metricsState.js";
import type { MetricsRecorder } from "../middleware/metricsState.js";
import { composePipeline } from "../middleware/pipeline.js";
import { rejectionChatReply } from "../middleware/rejectionReplies.js";
import type { Middleware, NextFn, OutboundApi } from "../plugin/types.js";
import type { RoleResolver } from "../permissions/types.js";
import { catalogFromEntries } from "../router/catalog.js";
import { createRouter } from "../router/router.js";
import type { Router } from "../router/router.js";
import { createStorage } from "../storage/storage.js";
import type { StorageEngine } from "../storage/storage.js";
import type { BotEvent, Message, SendOptions } from "../types.js";
import { loadPlugins } from "./loader.js";
import type { LoadedPlugins } from "./loader.js";
import { applyPluginConfig } from "./pluginConfig.js";
import { watchPluginsDir } from "./reloadWatcher.js";
import type { DirWatcher } from "./reloadWatcher.js";
import { Scheduler } from "./scheduler.js";
import { systemClock } from "./systemClock.js";
import type {
  MetricsSnapshot,
  RegistryCounts,
  RunningBot,
  StartOptions,
  StopSummary,
} from "./types.js";

const FILE_PATTERN = /\.(ts|js)$/i;
const EXCLUDED_PATTERN = /(\.test\.|\.d\.(ts|js)$)/i;

function scanPluginFilePaths(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => FILE_PATTERN.test(entry.name))
      .filter((entry) => !EXCLUDED_PATTERN.test(entry.name))
      .filter((entry) => !entry.name.startsWith("_"))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export function createConfiguredAdapter(config: PlugbotConfig, clock: Clock): Adapter {
  const options = config.adapter.options as Record<string, unknown>;
  switch (config.adapter.type) {
    case "mock":
      return new MockAdapter({ ...(options as MockAdapterOptions), clock });
    case "transcript":
      return new TranscriptAdapter({ ...(options as unknown as TranscriptAdapterOptions), clock });
    case "irc":
      return new IrcAdapter(options as unknown as IrcAdapterOptions, { clock });
  }
}

function listenerMatches(
  listener: { patternSource?: string; patternFlags?: string; patternText?: string },
  text: string,
): boolean {
  if (listener.patternText !== undefined) return text.includes(listener.patternText);
  if (listener.patternSource === undefined) return true;
  return new RegExp(listener.patternSource, listener.patternFlags ?? "").test(text);
}

function regexMatchOf(
  listener: { patternSource?: string; patternFlags?: string },
  text: string,
): RegExpMatchArray | null {
  if (listener.patternSource === undefined) return null;
  return text.match(new RegExp(listener.patternSource, listener.patternFlags ?? ""));
}

export async function startBot(options: StartOptions): Promise<RunningBot> {
  const config = options.config;
  const clock = options.clock ?? systemClock();
  const logger = options.logger ?? createDefaultLogger({ level: config.logging.level });
  const coreLog = logger.child("core");
  const adapter = options.adapterInstance ?? createConfiguredAdapter(config, clock);
  const outbound: OutboundApi = adapter;

  const storage = await createStorage({ file: resolve(config.storage.file), logger });

  const loaded = await loadPlugins({
    dir: resolve(config.plugins.dir),
    disabled: [...config.plugins.disabled],
    isolation: config.plugins.isolation,
    limits: {
      handlerTimeoutMs: config.limits.handlerTimeoutMs,
      breakerThreshold: config.limits.breakerThreshold,
      breakerWindowMs: config.limits.breakerWindowMs,
      breakerCooldownMs: config.limits.breakerCooldownMs,
    },
    clock,
    logger,
    outbound,
    storeNamespaceFor: (pluginName) => storage.namespaceFor(pluginName),
    capabilities: adapter.capabilities,
    configFor: (pluginName) => config.pluginConfigs[pluginName] ?? {},
    finalizeConfig: (schema, raw) => applyPluginConfig(schema, raw),
  });

  const recorder: MetricsRecorder = createMetricsRecorder(clock);
  const startedAt = clock.now();

  const cooldowns = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  const contextSignal = new AbortController();
  let stopped = false;
  let drainedHandlers = 0;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    const tracked = promise.finally(() => {
      pending.delete(tracked);
      if (stopped) drainedHandlers += 1;
    });
    pending.add(tracked);
    return tracked;
  };

  function recordPluginFailure(pluginName: string, cause: unknown): void {
    recorder.recordHandlerFailure(pluginName);
    const detail = cause instanceof Error ? { error: cause.message } : { error: String(cause) };
    if (cause instanceof HandlerError || cause instanceof HandlerTimeoutError) {
      coreLog.warn("plugin handler failed", { plugin: pluginName, ...cause.fields, ...detail });
      return;
    }
    coreLog.warn("plugin invocation failed", { plugin: pluginName, ...detail });
  }

  async function invokePlugin(pluginName: string, invoke: () => Promise<void>): Promise<void> {
    const runtime = loaded.registry.get(pluginName);
    if (runtime === undefined || stopped) return;
    try {
      await track(invoke());
    } catch (cause) {
      if (cause instanceof CircuitOpenError) throw cause;
      recordPluginFailure(pluginName, cause);
      throw cause;
    }
  }

  function replyTo(message: Message, text: string): Promise<unknown> {
    const sendOptions: SendOptions | undefined =
      message.threadId !== undefined && adapter.capabilities.threads
        ? { threadId: message.threadId }
        : undefined;
    return outbound.send(message.channelId, text, sendOptions);
  }

  function safeReply(message: Message, text: string): void {
    track(
      replyTo(message, text).catch((cause: unknown) => {
        coreLog.error("delivery of framework reply failed", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }),
    );
  }

  const catalog = catalogFromEntries(
    loaded.registry.all().flatMap((runtime) =>
      runtime.manifest.commands.map((command) => ({
        plugin: runtime.name,
        path: command.path,
        description: command.description,
        aliases: command.aliases,
        args: command.args,
        permission: command.permission,
        hidden: command.hidden,
        runnable: command.runnable,
      })),
    ),
  );

  const roleResolver: RoleResolver = {
    resolveRoles: (userId, channelId) => adapter.resolveRoles(userId, channelId),
    supportsRoles: () => adapter.capabilities.roles,
  };

  const router = createRouter(
    {
      catalog,
      replyTo: (message, text) => replyTo(message, text),
      authorizer: createAuthorizer({
        roleResolver,
        adminUserIds: config.permissions.adminUserIds,
        denyByDefaultAdmin: config.permissions.denyByDefaultAdmin,
        logger: coreLog,
      }),
      invocation: {
        prefix: config.commands.prefix,
        mentionAliases: config.commands.mentionAliases,
      },
    },
    {
      runCommand: async ({ plugin, path, message, args, rawArgs }) => {
        await invokePlugin(plugin, async () => {
          const runtime = loaded.registry.get(plugin);
          if (runtime === undefined) return;
          await runtime.invokeCommand([...path], message, args, [...rawArgs]);
        });
      },
    },
  );

  function cooldownAllows(
    plugin: string,
    listener: string,
    channelId: string,
    cooldownMs: number | undefined,
  ): boolean {
    if (cooldownMs === undefined || cooldownMs <= 0) return true;
    const key = `${plugin}\u0000${listener}\u0000${channelId}`;
    const now = clock.now();
    const last = cooldowns.get(key);
    if (last !== undefined && now - last < cooldownMs) return false;
    if (cooldowns.size > 5000) {
      for (const [existingKey, firedAt] of cooldowns) {
        if (now - firedAt > 600_000) cooldowns.delete(existingKey);
      }
    }
    cooldowns.set(key, now);
    return true;
  }

  async function fanoutListeners(message: Message): Promise<void> {
    for (const runtime of loaded.registry.all()) {
      for (const listener of runtime.manifest.listeners) {
        if (!listenerMatches(listener, message.text)) continue;
        if (!cooldownAllows(runtime.name, listener.name, message.channelId, listener.cooldownMs)) continue;
        try {
          await invokePlugin(runtime.name, () =>
            runtime.invokeListener(listener.name, message, regexMatchOf(listener, message.text)),
          );
        } catch {
          coreLog.debug("listener failure contained", {
            plugin: runtime.name,
            listener: listener.name,
          });
        }
      }
    }
  }

  function pluginMiddleware(): Middleware[] {
    const collected: Middleware[] = [];
    for (const runtime of loaded.registry.all()) {
      if (runtime.middleware !== undefined) collected.push(...runtime.middleware);
    }
    return collected;
  }

  let pipelineChain = buildPipelineChain();
  function buildPipelineChain(): (message: Message, terminal: NextFn) => Promise<void> {
    return composePipeline([
      loggingMiddleware(logger.child("pipeline"), clock),
      metricsMiddleware(recorder),
      rateLimitMiddleware({ perMinute: config.limits.userCommandsPerMinute, clock }),
      ...pluginMiddleware(),
      ...(options.extraMiddleware ?? []),
    ]);
  }

  function rebuildPipeline(): void {
    pipelineChain = buildPipelineChain();
  }

  async function processMessageEvent(message: Message): Promise<void> {
    try {
      await track(
        pipelineChain(message, async () => {
          const result = await router.handleMessage(message);
          if (result.status === "handled") recorder.recordCommand("ok");
          await fanoutListeners(message);
        }),
      );
    } catch (cause) {
      const chatReply = rejectionChatReply(cause);
      if (chatReply !== null) {
        coreLog.debug("message rejected", {
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        safeReply(message, chatReply);
        return;
      }
      if (cause instanceof HandlerError || cause instanceof HandlerTimeoutError) {
        coreLog.warn("command failed", { ...cause.fields });
        safeReply(message, "that command failed - see bot logs.");
        return;
      }
      coreLog.error("message dispatch failed unexpectedly", {
        error: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      });
      safeReply(message, "that command failed - see bot logs.");
    }
  }

  async function processMemberEvent(event: BotEvent): Promise<void> {
    for (const runtime of loaded.registry.all()) {
      if (!runtime.manifest.events.includes(event.type)) continue;
      try {
        await invokePlugin(runtime.name, () => runtime.invokeEvent(event.type, event));
      } catch {
        coreLog.debug("event hook failure contained", { plugin: runtime.name, event: event.type });
      }
    }
  }

  function handleEvent(event: BotEvent): void {
    if (stopped) return;
    void (async () => {
      if (event.type === "message") await processMessageEvent(event.message);
      else await processMemberEvent(event);
    })().catch((cause: unknown) => {
      coreLog.error("event processing failed", {
        eventType: event.type,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  function scheduleAllJobs(): void {
    scheduler.reset();
    for (const runtime of loaded.registry.all()) {
      for (const job of runtime.manifest.jobs) {
        scheduler.schedule({ plugin: runtime.name, manifest: job }, (scheduledFor) =>
          invokePlugin(runtime.name, () => runtime.invokeJob(job.name, scheduledFor)),
        );
      }
    }
    rebuildPipeline();
  }

  const scheduler = new Scheduler(clock, (plugin, job, fields) => {
    coreLog.warn("scheduled job failed", { plugin, job, ...fields });
  });

  scheduleAllJobs();

  await adapter.start({ dispatch: handleEvent });

  let watcher: DirWatcher | null = null;
  if (options.hotReload === true) {
    watcher = watchPluginsDir(resolve(config.plugins.dir), (filePath) => {
      loaded
        .reloadFile(filePath)
        .then((status) => {
          if (status === "unchanged") return;
          coreLog.info("plugin reloaded", { file: filePath, status });
          scheduleAllJobs();
        })
        .catch((cause: unknown) => {
          coreLog.error("hot reload failed", {
            file: filePath,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }, clock);
  }

  coreLog.info("bot ready", {
    adapter: adapter.name,
    plugins: loaded.registry.all().length,
  });
  options.onReady?.();

  const runningBot: RunningBot = {
    adapterName: adapter.name,
    commandNames(): readonly string[] {
      return catalog
        .commands()
        .filter((entry) => entry.hidden !== true)
        .map((entry) => entry.path.join(" "))
        .sort();
    },
    registryCounts(): RegistryCounts {
      return loaded.registry.counts();
    },
    metrics(): MetricsSnapshot {
      return recorder.snapshot();
    },
    async reloadPlugins(): Promise<void> {
      for (const filePath of scanPluginFilePaths(resolve(config.plugins.dir))) {
        const status = await loaded.reloadFile(filePath);
        if (status !== "unchanged") {
          coreLog.info("plugin reloaded", { file: filePath, status });
        }
      }
      scheduleAllJobs();
    },
    async stop(stopOptions?: { drainMs?: number }): Promise<StopSummary> {
      const stopStartedAt = clock.now();
      stopped = true;
      watcher?.close();
      scheduler.stopAll();
      contextSignal.abort();

      const drainBudget = stopOptions?.drainMs ?? config.limits.shutdownDrainMs;
      const virtualDeadline = clock.now() + drainBudget;
      const realDeadline = Date.now() + drainBudget;
      while (pending.size > 0 && clock.now() < virtualDeadline && Date.now() < realDeadline) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 20));
      }

      const runtimes = loaded.registry.all();
      let forcedTerminations = 0;
      for (const runtime of runtimes) {
        loaded.registry.unregister(runtime.name);
        try {
          const shutdownResult = await runtime.shutdown(drainBudget);
          if (!shutdownResult.drained) forcedTerminations += 1;
        } catch {
          forcedTerminations += 1;
        }
        await runtime.dispose().catch(() => {});
      }

      const storageFlushed = await storage.close();
      await adapter.stop();
      const elapsedMs = clock.now() - stopStartedAt;
      coreLog.info("bot stopped", {
        drainedHandlers,
        forcedTerminations,
        storageFlushed,
        elapsedMs,
        uptimeMs: clock.now() - startedAt,
      });
      return { drainedHandlers, forcedTerminations, storageFlushed, elapsedMs };
    },
  };

  return runningBot;
}
