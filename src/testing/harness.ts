import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MockDelivery } from "../adapter/mock.js";
import { MockAdapter } from "../adapter/mock.js";
import { DEFAULT_CONFIG } from "../config/types.js";
import type { PlugbotConfig } from "../config/types.js";
import { createDefaultLogger } from "../logging/defaultLogger.js";
import { startBot } from "../runtime/bot.js";
import type { MetricsSnapshot, RegistryCounts, RunningBot, StopSummary } from "../runtime/types.js";
import { ManualClock } from "./manualClock.js";

const HARNESS_ROOT = resolve("tests", "tmp-harness");
const QUIET_POLL_MS = 25;
const QUIET_STABLE_FRAMES = 4;
const QUIET_FIRST_CHANGE_MS = 400;
const QUIET_CAP_MS = 6000;
const CLEANUP_ATTEMPTS = 8;
const CLEANUP_RETRY_MS = 150;

let runCounter = 0;

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function nextRunId(): string {
  runCounter += 1;
  return [
    process.pid.toString(36),
    Date.now().toString(36),
    runCounter.toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("-");
}

export interface HarnessPaths {
  readonly runDir: string;
  readonly pluginsDir: string;
  storageFile: string;
}

export function allocateHarnessPaths(): HarnessPaths {
  const runDir = join(HARNESS_ROOT, nextRunId());
  const pluginsDir = join(runDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  return { runDir, pluginsDir, storageFile: join(runDir, "storage.json") };
}

export async function removeHarnessPaths(paths: HarnessPaths): Promise<void> {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      rmSync(paths.runDir, { recursive: true, force: true });
      return;
    } catch {
      await delay(CLEANUP_RETRY_MS);
    }
  }
}

export function writePluginSources(pluginsDir: string, sources: Record<string, string>): void {
  mkdirSync(pluginsDir, { recursive: true });
  for (const [fileNameWithExt, content] of Object.entries(sources)) {
    writeFileSync(join(pluginsDir, fileNameWithExt), content, "utf8");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValue<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key];
    merged[key] =
      existing !== undefined && isPlainObject(existing) && isPlainObject(value)
        ? mergeValue(existing, value)
        : value;
  }
  return merged as T;
}

export interface TestBotOptions {
  configOverrides?: Partial<PlugbotConfig>;
  pluginSources?: Record<string, string>;
  storageFileName?: string;
  hotReload?: boolean;
}

function finalizeTestConfig(
  paths: HarnessPaths,
  overrides?: Partial<PlugbotConfig>,
): PlugbotConfig {
  const merged = mergeValue(structuredClone(DEFAULT_CONFIG), overrides);
  merged.plugins.dir = paths.pluginsDir;
  merged.storage.file = paths.storageFile;
  if (overrides?.logging?.level === undefined) merged.logging.level = "error";
  return merged;
}

export function makeTestConfig(overrides?: Partial<PlugbotConfig>): PlugbotConfig {
  const paths = allocateHarnessPaths();
  return finalizeTestConfig(paths, overrides);
}

export interface ReceiveInput {
  from?: string;
  text: string;
  channelId?: string;
  threadId?: string;
}

export interface TextLine {
  text: string;
  channelId: string;
  threadId?: string;
}

export interface TranscriptPage {
  texts(): TextLine[];
  reactions(): Array<{ messageId: string; emoji: string }>;
  edits(): Array<{ messageId: string; channelId: string; text: string }>;
  deletions(): Array<{ messageId: string; channelId: string }>;
  all(): readonly MockDelivery[];
}

function snapshotPage(deliveries: readonly MockDelivery[]): TranscriptPage {
  return {
    texts(): TextLine[] {
      return deliveries
        .filter((delivery): delivery is Extract<MockDelivery, { kind: "send" }> => delivery.kind === "send")
        .map((delivery) => ({
          text: delivery.text,
          channelId: delivery.channelId,
          ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
        }));
    },
    reactions() {
      return deliveries
        .filter((delivery): delivery is Extract<MockDelivery, { kind: "react" }> => delivery.kind === "react")
        .map((delivery) => ({ messageId: delivery.messageId, emoji: delivery.emoji }));
    },
    edits() {
      return deliveries
        .filter((delivery): delivery is Extract<MockDelivery, { kind: "edit" }> => delivery.kind === "edit")
        .map((delivery) => ({
          messageId: delivery.messageId,
          channelId: delivery.channelId,
          text: delivery.text,
        }));
    },
    deletions() {
      return deliveries
        .filter((delivery): delivery is Extract<MockDelivery, { kind: "delete" }> => delivery.kind === "delete")
        .map((delivery) => ({ messageId: delivery.messageId, channelId: delivery.channelId }));
    },
    all(): readonly MockDelivery[] {
      return [...deliveries];
    },
  };
}

export class TestBot {
  static async create(options: TestBotOptions = {}): Promise<TestBot> {
    const paths = allocateHarnessPaths();
    if (options.storageFileName !== undefined) {
      paths.storageFile = isAbsolute(options.storageFileName)
        ? options.storageFileName
        : join(paths.runDir, options.storageFileName);
    }
    writePluginSources(paths.pluginsDir, options.pluginSources ?? {});
    const config = finalizeTestConfig(paths, options.configOverrides);
    const logger = createDefaultLogger({ level: config.logging.level });
    const clock = new ManualClock();
    const mock = new MockAdapter({ clock });
    const running = await startBot({
      config,
      logger,
      clock,
      adapterInstance: mock,
      hotReload: options.hotReload === true,
    });
    return new TestBot(running, mock, clock, paths);
  }

  readonly #running: RunningBot;
  readonly #mock: MockAdapter;
  readonly #clock: ManualClock;
  readonly #paths: HarnessPaths;
  #stopped = false;

  private constructor(running: RunningBot, mock: MockAdapter, clock: ManualClock, paths: HarnessPaths) {
    this.#running = running;
    this.#mock = mock;
    this.#clock = clock;
    this.#paths = paths;
  }

  get mock(): MockAdapter {
    return this.#mock;
  }

  get clock(): ManualClock {
    return this.#clock;
  }

  async receive(input: ReceiveInput): Promise<TranscriptPage> {
    const seqBefore = this.lastSeq();
    this.#mock.simulateMessage({
      username: input.from ?? "alice",
      channelId: input.channelId ?? "general",
      text: input.text,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    });
    await this.awaitQuiet();
    return snapshotPage(this.#mock.deliveries().filter((delivery) => delivery.seq > seqBefore));
  }

  advanceMs(stepMs: number): Promise<void> {
    return this.#clock.advanceMs(stepMs);
  }

  sentAfter(seq: number): readonly MockDelivery[] {
    return this.#mock.deliveries().filter((delivery) => delivery.seq > seq);
  }

  commandNames(): readonly string[] {
    return this.#running.commandNames();
  }

  metrics(): MetricsSnapshot {
    return this.#running.metrics();
  }

  registryCounts(): RegistryCounts {
    return this.#running.registryCounts();
  }

  reloadPlugins(): Promise<void> {
    return this.#running.reloadPlugins();
  }

  async stop(options?: { drainMs?: number }): Promise<StopSummary | null> {
    if (this.#stopped) return null;
    this.#stopped = true;
    const summary = await this.#running.stop({ drainMs: options?.drainMs });
    await removeHarnessPaths(this.#paths);
    return summary;
  }

  harnessPaths(): HarnessPaths {
    return this.#paths;
  }

  lastSeq(): number {
    const deliveries = this.#mock.deliveries();
    const last = deliveries[deliveries.length - 1];
    return last === undefined ? 0 : last.seq;
  }

  private async awaitQuiet(): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + QUIET_CAP_MS;
    let previous = this.lastSeq();
    let changed = false;
    while (!changed && Date.now() - startedAt < QUIET_FIRST_CHANGE_MS && Date.now() < deadline) {
      await delay(QUIET_POLL_MS);
      const current = this.lastSeq();
      if (current !== previous) {
        changed = true;
        previous = current;
      }
    }
    let stableFrames = 0;
    while (stableFrames < QUIET_STABLE_FRAMES && Date.now() < deadline) {
      await delay(QUIET_POLL_MS);
      const current = this.lastSeq();
      if (current === previous) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        previous = current;
        changed = true;
      }
    }
  }
}

export function configHarnessPaths(config: PlugbotConfig): HarnessPaths {
  return {
    runDir: dirname(config.storage.file),
    pluginsDir: config.plugins.dir,
    storageFile: config.storage.file,
  };
}
