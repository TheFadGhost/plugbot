import { mkdir, readFile, rename, rm, unlink, access, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Clock, ClockTimeout } from "../clock.js";
import type { Logger } from "../logging/types.js";
import type { PluginStore } from "../plugin/types.js";
import { StorageError } from "../errors.js";

export interface StorageOptions {
  file: string;
  logger: Logger;
  clock?: Clock;
  debounceMs?: number;
}

export interface StorageEngine {
  namespaceFor(pluginName: string): PluginStore;
  /** Forces any pending debounced write; resolves true when a write actually landed. */
  flushAll(): Promise<boolean>;
  /** Flushes pending state, cancels the debounce timer, seals the engine. */
  close(): Promise<boolean>;
}

const DEFAULT_DEBOUNCE_MS = 30;

const RETRY_DELAY_MS = 20;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    const timer = setTimeout(() => handler(), ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

const wait = (ms: number): Promise<void> => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isMissing = (cause: unknown): boolean =>
  (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

async function renameRobust(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw cause;
    await wait(RETRY_DELAY_MS);
    try {
      await unlink(to);
    } catch (unlinkCause) {
      if (!isMissing(unlinkCause)) throw unlinkCause;
    }
    await rename(from, to);
  }
}

function failUnserializable(namespace: string, key: string, path: string, reason: string): never {
  throw new TypeError(
    `storage set rejected a non-serializable value in namespace "${namespace}" for key "${key}": ${reason} at ${path}`,
  );
}

function assertSerializable(namespace: string, key: string, rootValue: unknown): void {
  const ancestors = new Set<object>();
  const visit = (nodeValue: unknown, path: string): void => {
    if (nodeValue === undefined) failUnserializable(namespace, key, path, "undefined");
    const kind = typeof nodeValue;
    if (kind === "function") failUnserializable(namespace, key, path, "function");
    if (kind === "symbol") failUnserializable(namespace, key, path, "symbol");
    if (kind === "bigint") failUnserializable(namespace, key, path, "bigint");
    if (nodeValue === null || kind !== "object") return;
    const node = nodeValue as object;
    if (ancestors.has(node)) failUnserializable(namespace, key, path, "circular reference");
    ancestors.add(node);
    if (node instanceof Map) failUnserializable(namespace, key, path, "Map");
    if (node instanceof Set) failUnserializable(namespace, key, path, "Set");
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index++) visit(node[index], `${path}[${index}]`);
    } else {
      for (const [entryKey, entryValue] of Object.entries(node)) {
        visit(entryValue, `${path}.${entryKey}`);
      }
    }
    ancestors.delete(node);
  };
  visit(rootValue, "root");
}

export class JsonStorageEngine implements StorageEngine {
  readonly #file: string;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #debounceMs: number;
  readonly #state = new Map<string, Map<string, unknown>>();
  readonly #stores = new Map<string, PluginStore>();
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ClockTimeout | null = null;
  #dirty = false;
  #sealed = false;

  constructor(options: StorageOptions) {
    this.#file = options.file;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async loadFromDisk(): Promise<void> {
    let rawMain: string | null = null;
    try {
      rawMain = await readFile(this.#file, "utf8");
    } catch {
      rawMain = null;
    }
    if (rawMain !== null) {
      const doc = JsonStorageEngine.parseDocument(rawMain);
      if (doc !== null) {
        this.adopt(doc);
        this.#logger.debug("storage loaded", { file: this.#file });
        return;
      }
    }
    let rawBackup: string | null = null;
    try {
      rawBackup = await readFile(`${this.#file}.bak`, "utf8");
    } catch {
      rawBackup = null;
    }
    if (rawBackup !== null) {
      const doc = JsonStorageEngine.parseDocument(rawBackup);
      if (doc !== null) {
        this.adopt(doc);
        this.#logger.error("storage recovered from backup", { file: this.#file });
        return;
      }
    }
    if (rawMain === null && rawBackup === null) {
      this.#logger.debug("storage file absent - starting empty", { file: this.#file });
      return;
    }
    this.#logger.error("storage unreadable - starting empty", { file: this.#file });
  }

  private static parseDocument(raw: string): Record<string, Record<string, unknown>> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const document = parsed as Record<string, unknown>;
    if (document["version"] !== 1) return null;
    const plugins = document["plugins"];
    if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return null;
    const namespaces: Record<string, Record<string, unknown>> = {};
    for (const [name, value] of Object.entries(plugins)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      namespaces[name] = value as Record<string, unknown>;
    }
    return namespaces;
  }

  private adopt(namespaces: Record<string, Record<string, unknown>>): void {
    this.#state.clear();
    for (const [name, values] of Object.entries(namespaces)) {
      this.#state.set(name, new Map(Object.entries(values)));
    }
  }

  namespaceFor(pluginName: string): PluginStore {
    const existing = this.#stores.get(pluginName);
    if (existing !== undefined) return existing;
    const store = this.buildStore(pluginName);
    this.#stores.set(pluginName, store);
    return store;
  }

  private buildStore(pluginName: string): PluginStore {
    const engine = this;
    return {
      async get<T>(key: string): Promise<T | undefined> {
        engine.ensureOpen(pluginName);
        const value = engine.namespaceEntries(pluginName).get(key);
        return value === undefined ? undefined : (structuredClone(value) as T);
      },
      async set<T>(key: string, value: T): Promise<void> {
        engine.ensureOpen(pluginName);
        assertSerializable(pluginName, key, value);
        engine.namespaceEntries(pluginName).set(key, structuredClone(value));
        engine.markDirty();
      },
      async delete(key: string): Promise<boolean> {
        engine.ensureOpen(pluginName);
        const existed = engine.namespaceEntries(pluginName).delete(key);
        if (existed) engine.markDirty();
        return existed;
      },
      async list(prefix?: string): Promise<Array<[string, unknown]>> {
        engine.ensureOpen(pluginName);
        const entries = engine.namespaceEntries(pluginName);
        const pairs: Array<[string, unknown]> = [];
        for (const key of [...entries.keys()].sort()) {
          if (prefix !== undefined && !key.startsWith(prefix)) continue;
          pairs.push([key, structuredClone(entries.get(key))]);
        }
        return pairs;
      },
      async clear(): Promise<void> {
        engine.ensureOpen(pluginName);
        const entries = engine.namespaceEntries(pluginName);
        if (entries.size > 0) {
          entries.clear();
          engine.markDirty();
        }
      },
    };
  }

  private ensureOpen(namespace: string): void {
    if (this.#sealed) throw new StorageError("use after close", namespace);
  }

  private namespaceEntries(pluginName: string): Map<string, unknown> {
    let entries = this.#state.get(pluginName);
    if (entries === undefined) {
      entries = new Map();
      this.#state.set(pluginName, entries);
    }
    return entries;
  }

  private markDirty(): void {
    this.#dirty = true;
    this.armTimer();
  }

  private armTimer(): void {
    if (this.#timer !== null || this.#sealed) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.chain(() => this.flushNow());
    }, this.#debounceMs);
  }

  private disarmTimer(): void {
    if (this.#timer !== null) {
      this.#timer.cancel();
      this.#timer = null;
    }
  }

  private chain<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task, task);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async flushNow(): Promise<boolean> {
    if (!this.#dirty) return false;
    this.#dirty = false;
    try {
      return await this.writeDocument();
    } catch {
      try {
        return await this.writeDocument();
      } catch (cause) {
        this.#dirty = true;
        this.#logger.warn("storage write failed; retry exhausted", {
          file: this.#file,
          error: describeCause(cause),
        });
        return false;
      }
    }
  }

  private serializeDocument(): string {
    const plugins: Record<string, Record<string, unknown>> = {};
    for (const name of [...this.#state.keys()].sort()) {
      const entries = this.#state.get(name);
      if (entries === undefined || entries.size === 0) continue;
      const values: Record<string, unknown> = {};
      for (const key of [...entries.keys()].sort()) values[key] = entries.get(key);
      plugins[name] = values;
    }
    return JSON.stringify({ version: 1, plugins });
  }

  private async writeDocument(): Promise<boolean> {
    const payload = this.serializeDocument();
    const tempPath = `${this.#file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      await writeFile(tempPath, payload, "utf8");
      const backupPath = `${this.#file}.bak`;
      let mainExists = true;
      try {
        await access(this.#file);
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
        mainExists = false;
      }
      if (mainExists) {
        await rm(backupPath, { force: true });
        await renameRobust(this.#file, backupPath);
      }
      await renameRobust(tempPath, this.#file);
      return true;
    } catch (cause) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw cause;
    }
  }

  async flushAll(): Promise<boolean> {
    this.disarmTimer();
    if (this.#sealed) return false;
    return this.chain(() => this.flushNow());
  }

  async close(): Promise<boolean> {
    if (this.#sealed) return false;
    this.#sealed = true;
    this.disarmTimer();
    return this.chain(() => this.flushNow());
  }
}

export async function createStorage(options: StorageOptions): Promise<StorageEngine> {
  const engine = new JsonStorageEngine(options);
  await engine.loadFromDisk();
  return engine;
}
