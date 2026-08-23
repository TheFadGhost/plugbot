/**
 * Loads plugin files from a directory into a PluginRegistry. Startup
 * failures are contained: a plugin that cannot be imported, validated, or
 * initialised is logged and skipped so the bot still starts without it.
 * See DESIGN.md sections 3 (startup throws, inbound logs) and 8 (isolation).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { OutboundApi, PluginConfigSchema, PluginStore } from "../plugin/types.js";
import type { Capabilities } from "../adapter/adapter.js";
import type { Clock, ClockTimeout } from "../clock.js";
import type { Logger } from "../logging/types.js";
import { HandlerTimeoutError, PluginLoadError } from "../errors.js";
import type { BreakerChangeFields, BreakerState } from "./breaker.js";
import type { RuntimeLimits } from "./pluginRuntime.js";
import type { PluginIsolation } from "./manifest.js";
import type { PluginRuntime } from "./pluginRuntime.js";
import { InlinePluginRuntime } from "./inlineRuntime.js";
import { PluginRegistry } from "./registry.js";
import { ThreadPluginRuntime } from "./workerBridge.js";

export interface LoadPluginsOptions {
  dir: string;
  disabled: string[];
  isolation: PluginIsolation;
  limits: RuntimeLimits;
  clock: Clock;
  logger: Logger;
  outbound: OutboundApi;
  storeNamespaceFor: (pluginName: string) => PluginStore;
  capabilities: Capabilities;
  configFor: (pluginName: string) => Record<string, unknown>;
  finalizeConfig?: (
    schema: PluginConfigSchema | undefined,
    raw: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface LoadedPlugins {
  readonly registry: PluginRegistry;
  disposeAll(graceMs: number): Promise<void>;
  reloadFile(filePath: string): Promise<"reloaded" | "removed" | "unchanged">;
  registrationCounts(): RegistryCountsLike;
}

interface RegistryCountsLike {
  plugins: Array<{ plugin: string; commands: number; listeners: number; jobs: number }>;
}

const FILE_PATTERN = /\.(ts|js)$/i;
const TEST_PATTERN = /\.test\./i;
const DECLARATION_PATTERN = /\.d\.(ts|js)$/i;

function scanPluginFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => FILE_PATTERN.test(entry.name))
    .filter((entry) => !TEST_PATTERN.test(entry.name))
    .filter((entry) => !DECLARATION_PATTERN.test(entry.name))
    .filter((entry) => !entry.name.startsWith("_"))
    .map((entry) => join(dir, entry.name))
    .sort();
}

function stemOf(file: string): string {
  return basename(file).replace(FILE_PATTERN, "");
}

async function raceWithTimeout<T>(
  clock: Clock,
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
): Promise<T> {
  const timerRef: { current: ClockTimeout | null } = { current: null };
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectTimeout) => {
        timerRef.current = clock.setTimeout(() => rejectTimeout(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    timerRef.current?.cancel();
  }
}

export async function loadPlugins(options: LoadPluginsOptions): Promise<LoadedPlugins> {
  const {
    dir,
    disabled,
    isolation,
    limits,
    clock,
    logger,
    outbound,
    storeNamespaceFor,
    capabilities,
    configFor,
    finalizeConfig,
  } = options;
  const loaderLogger = logger.child("loader");
  const registry = new PluginRegistry();
  const runtimesByFile = new Map<string, PluginRuntime>();
  const loadedContentByFile = new Map<string, string>();

  const buildThread = (file: string, provisionalName: string): ThreadPluginRuntime =>
    new ThreadPluginRuntime({
      pluginFile: file,
      pluginName: provisionalName,
      limits,
      clock,
      logger,
      outbound,
      store: storeNamespaceFor(provisionalName),
      capabilities,
      config: configFor(provisionalName),
      finalizeConfig,
    });

  const buildInline = (file: string, provisionalName: string): InlinePluginRuntime =>
    new InlinePluginRuntime({
      pluginFile: file,
      pluginName: provisionalName,
      limits,
      clock,
      logger,
      outbound,
      store: storeNamespaceFor(provisionalName),
      capabilities,
      config: configFor(provisionalName),
      finalizeConfig,
    });

  const initialise = async (runtime: PluginRuntime): Promise<void> => {
    await raceWithTimeout(
      clock,
      runtime.breaker.guard(() => runtime.init()),
      limits.handlerTimeoutMs,
      () => new HandlerTimeoutError(runtime.name, "init", "init", limits.handlerTimeoutMs),
    );
  };

  const createRuntime = async (file: string): Promise<PluginRuntime> => {
    const stem = stemOf(file);
    if (isolation === "inline") {
      const inline = buildInline(file, stem);
      try {
        await initialise(inline);
        if (inline.manifest.isolation === "thread") {
          await inline.dispose();
          return await createThreadResolved(file, stem);
        }
        return inline;
      } catch (cause: unknown) {
        await inline.dispose().catch(() => {});
        throw cause;
      }
    }
    return createThreadResolved(file, stem);
  };

  const createThreadResolved = async (file: string, stem: string): Promise<PluginRuntime> => {
    const first = buildThread(file, stem);
    try {
      await initialise(first);
    } catch (cause: unknown) {
      await first.dispose().catch(() => {});
      throw cause;
    }
    const manifest = first.manifest;
    if (manifest.isolation !== "inline" && manifest.name === stem) return first;
    await first.dispose();
    if (manifest.isolation === "inline") {
      const inline = buildInline(file, manifest.name);
      try {
        await initialise(inline);
        return inline;
      } catch (cause: unknown) {
        await inline.dispose().catch(() => {});
        throw cause;
      }
    }
    const rebuilt = buildThread(file, manifest.name);
    try {
      await initialise(rebuilt);
      return rebuilt;
    } catch (cause: unknown) {
      await rebuilt.dispose().catch(() => {});
      throw cause;
    }
  };

  const adopt = (runtime: PluginRuntime): void => {
    runtime.breaker.onStateChange = (from: BreakerState, to: BreakerState, fields: BreakerChangeFields) => {
      loaderLogger.warn("breaker state changed", { plugin: runtime.name, from, to, ...fields });
    };
    registry.register(runtime);
  };

  const loadFile = async (file: string): Promise<boolean> => {
    const stem = stemOf(file);
    if (disabled.includes(stem)) return false;
    let runtime: PluginRuntime;
    try {
      runtime = await createRuntime(file);
    } catch (cause: unknown) {
      const error = cause instanceof PluginLoadError ? cause : new PluginLoadError(file, cause instanceof Error ? cause.message : String(cause), cause);
      loaderLogger.error("plugin skipped", { pluginFile: file, reason: error.message });
      return false;
    }
    if (disabled.includes(runtime.name)) {
      await runtime.dispose().catch(() => {});
      return false;
    }
    try {
      adopt(runtime);
    } catch (cause: unknown) {
      await runtime.dispose().catch(() => {});
      const reason = cause instanceof Error ? cause.message : String(cause);
      loaderLogger.error("plugin skipped", { pluginFile: file, reason });
      return false;
    }
    runtimesByFile.set(resolve(file), runtime);
    loadedContentByFile.set(resolve(file), readFileSync(file, "utf8"));
    return true;
  };

  for (const file of scanPluginFiles(dir)) {
    await loadFile(file);
  }

  const shutdownAndDispose = async (runtime: PluginRuntime, graceMs: number): Promise<void> => {
    try {
      await runtime.shutdown(graceMs);
    } catch {
      // containment boundary; disposal proceeds regardless
    }
    await runtime.dispose().catch(() => {});
  };

  return {
    registry,

    async disposeAll(graceMs: number): Promise<void> {
      const all = registry.all();
      for (const runtime of all) registry.unregister(runtime.name);
      await Promise.allSettled(all.map((runtime) => shutdownAndDispose(runtime, graceMs)));
      runtimesByFile.clear();
      loadedContentByFile.clear();
    },

    async reloadFile(filePath: string): Promise<"reloaded" | "removed" | "unchanged"> {
      const abs = resolve(filePath);
      const existing = runtimesByFile.get(abs);
      if (!existsSync(abs)) {
        if (existing === undefined) return "removed";
        registry.unregister(existing.name);
        runtimesByFile.delete(abs);
        loadedContentByFile.delete(abs);
        await shutdownAndDispose(existing, 2000);
        return "removed";
      }
      const content = readFileSync(abs, "utf8");
      if (existing !== undefined && loadedContentByFile.get(abs) === content) return "unchanged";
      const fresh = await createRuntime(abs);
      if (existing !== undefined) {
        registry.unregister(existing.name);
        runtimesByFile.delete(abs);
        await shutdownAndDispose(existing, 2000);
      }
      adopt(fresh);
      runtimesByFile.set(abs, fresh);
      loadedContentByFile.set(abs, content);
      return "reloaded";
    },

    registrationCounts(): RegistryCountsLike {
      return registry.counts();
    },
  };
}
