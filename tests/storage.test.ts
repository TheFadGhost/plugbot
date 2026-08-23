import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Clock, ClockTimeout } from "../src/clock.js";
import { StorageError } from "../src/errors.js";
import type { LogFields, Logger, LogLevel } from "../src/logging/types.js";
import { createStorage } from "../src/storage/storage.js";

const tmpRoot = join(dirname(fileURLToPath(import.meta.url)), "tmp-storage");

const wait = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

interface SinkEntry {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

function sinkLogger(sink: SinkEntry[]): Logger {
  const record = (level: LogLevel) => (msg: string, fields: LogFields = {}): void => {
    sink.push({ level, msg, fields });
  };
  return {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => sinkLogger(sink),
  };
}

class ManualClock implements Clock {
  #now = 0;
  readonly #timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  scheduledCount = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): ClockTimeout {
    this.scheduledCount += 1;
    const timer = { at: this.#now + ms, fn, cancelled: false };
    this.#timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  async advanceMs(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
      const due = this.#timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#now = Math.max(this.#now, due.at);
      due.cancelled = true;
      due.fn();
      await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
    }
    this.#now = target;
    await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
  }
}

afterEach(async () => {
  try {
    await rm(tmpRoot, { recursive: true, force: true });
  } catch {
    await wait(100);
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

describe("storage persistence", () => {
  it("set/get/delete survive engine reopen on the same file", async () => {
    await mkdir(tmpRoot, { recursive: true });
    const file = join(tmpRoot, "persistence.json");
    const firstSink: SinkEntry[] = [];
    const first = await createStorage({ file, logger: sinkLogger(firstSink) });
    expect(firstSink.some((entry) => entry.level === "debug")).toBe(true);

    const poll = first.namespaceFor("poll");
    await poll.set("keep", { v: 1 });
    await poll.set("gone", [1, 2, 3]);
    expect(await first.flushAll()).toBe(true);
    expect(await first.close()).toBe(false);

    const second = await createStorage({ file, logger: sinkLogger([]) });
    const reopened = second.namespaceFor("poll");
    expect(await reopened.get<{ v: number }>("keep")).toEqual({ v: 1 });
    expect(await reopened.delete("gone")).toBe(true);
    expect(await second.flushAll()).toBe(true);
    expect(await second.close()).toBe(false);

    const third = await createStorage({ file, logger: sinkLogger([]) });
    const finalStore = third.namespaceFor("poll");
    expect(await finalStore.get("gone")).toBeUndefined();
    expect(await finalStore.delete("gone")).toBe(false);
    expect(await finalStore.get("keep")).toEqual({ v: 1 });
    await third.close();
  });

  it("missing file starts empty with a debug log", async () => {
    await mkdir(tmpRoot, { recursive: true });
    const file = join(tmpRoot, "fresh.json");
    const sink: SinkEntry[] = [];
    const engine = await createStorage({ file, logger: sinkLogger(sink) });
    const entry = sink.find((item) => item.level === "debug");
    expect(entry?.fields["file"]).toBe(file);
    expect(await engine.namespaceFor("any").get("x")).toBeUndefined();
    await engine.close();
  });
});

describe("storage namespacing", () => {
  it("keeps two plugins with identical keys fully independent", async () => {
    const file = join(tmpRoot, "namespaces.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const alpha = engine.namespaceFor("alpha");
    const beta = engine.namespaceFor("beta");

    await alpha.set("state", "from-alpha");
    await beta.set("state", "from-beta");
    await alpha.set("extra", 1);

    expect(await beta.list()).toEqual([["state", "from-beta"]]);
    expect(await alpha.list()).toEqual([
      ["extra", 1],
      ["state", "from-alpha"],
    ]);

    await alpha.clear();
    expect(await alpha.get("state")).toBeUndefined();
    expect(await beta.get("state")).toBe("from-beta");

    expect(await engine.flushAll()).toBe(true);
    await engine.close();

    const reopened = await createStorage({ file, logger: sinkLogger([]) });
    expect(await reopened.namespaceFor("alpha").list()).toEqual([]);
    expect(await reopened.namespaceFor("beta").get("state")).toBe("from-beta");
    await reopened.close();
  });
});

describe("storage file format", () => {
  it("writes exactly version 1 with a plugins object", async () => {
    const file = join(tmpRoot, "format.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    await engine.namespaceFor("poll").set("openPolls", []);
    expect(await engine.flushAll()).toBe(true);

    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    expect(typeof parsed).toBe("object");
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object)).toEqual(["version", "plugins"]);
    expect(parsed).toEqual({ version: 1, plugins: { poll: { openPolls: [] } } });
    await engine.close();
  });

  it("sorts keys identically across consecutive dumps (byte compare)", async () => {
    const file = join(tmpRoot, "sorted.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const alpha = engine.namespaceFor("alpha");

    await alpha.set("zeta", 1);
    await alpha.set("beta", 2);
    await alpha.set("mid", 3);
    expect(await engine.flushAll()).toBe(true);
    const dumpOne = await readFile(file, "utf8");
    expect(dumpOne).toBe('{"version":1,"plugins":{"alpha":{"beta":2,"mid":3,"zeta":1}}}');

    const betaPlugin = engine.namespaceFor("beta-plugin");
    await betaPlugin.set("k", [1, 2]);
    expect(await engine.flushAll()).toBe(true);
    const dumpTwo = await readFile(file, "utf8");
    expect(dumpTwo).toContain('"alpha":{"beta":2,"mid":3,"zeta":1}');
    expect(dumpTwo.startsWith('{"version":1,"plugins":{"alpha"')).toBe(true);
    await engine.close();
  });
});

describe("storage debounce", () => {
  it("coalesces 10 rapid sets into one scheduled write and lands correct state", async () => {
    const file = join(tmpRoot, "debounce.json");
    const clock = new ManualClock();
    const engine = await createStorage({ file, logger: sinkLogger([]), clock });
    const store = engine.namespaceFor("bulk");

    for (let index = 0; index < 10; index++) {
      await store.set(`key${index}`, index);
    }
    expect(clock.scheduledCount).toBe(1);

    await clock.advanceMs(30);
    expect(await engine.flushAll()).toBe(false);

    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    const expected: Record<string, number> = {};
    for (let index = 0; index < 10; index++) expected[`key${index}`] = index;
    expect(raw).toEqual({ version: 1, plugins: { bulk: expected } });
    await engine.close();
  });

  it("flushAll lands immediately without debounce delay", async () => {
    const file = join(tmpRoot, "flush.json");
    const clock = new ManualClock();
    const engine = await createStorage({ file, logger: sinkLogger([]), clock });
    const store = engine.namespaceFor("now");

    await store.set("instant", true);
    expect(await engine.flushAll()).toBe(true);
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(parsed).toEqual({ version: 1, plugins: { now: { instant: true } } });
    expect(clock.scheduledCount).toBe(1);
    expect(await engine.flushAll()).toBe(false);
    await engine.close();
  });
});

describe("storage corruption recovery", () => {
  it("recovers from .bak when the main file is corrupt and logs error level", async () => {
    await mkdir(tmpRoot, { recursive: true });
    const file = join(tmpRoot, "recover.json");
    const first = await createStorage({ file, logger: sinkLogger([]) });
    const store = first.namespaceFor("poll");
    await store.set("a", 1);
    await first.flushAll();
    await store.set("b", 2);
    await first.flushAll();
    await first.close();

    await writeFile(file, Buffer.from([0xff, 0x00, 0x13, 0x7f, 0xff]));
    const sink: SinkEntry[] = [];
    const second = await createStorage({ file, logger: sinkLogger(sink) });
    const recovered = second.namespaceFor("poll");
    expect(await recovered.get("a")).toBe(1);
    expect(await recovered.get("b")).toBeUndefined();
    expect(
      sink.some(
        (entry) =>
          entry.level === "error" &&
          entry.msg === "storage recovered from backup" &&
          entry.fields["file"] === file,
      ),
    ).toBe(true);
    await second.close();
  });

  it("starts empty and stays usable when both files are corrupt", async () => {
    await mkdir(tmpRoot, { recursive: true });
    const file = join(tmpRoot, "bothcorrupt.json");
    await writeFile(file, "not json {{{");
    await writeFile(`${file}.bak`, "also not json");
    const sink: SinkEntry[] = [];

    const engine = await createStorage({ file, logger: sinkLogger(sink) });
    expect(
      sink.some((entry) => entry.level === "error" && entry.msg === "storage unreadable - starting empty"),
    ).toBe(true);

    const store = engine.namespaceFor("fresh");
    await store.set("recovered", false);
    expect(await engine.flushAll()).toBe(true);
    await engine.close();

    const reopened = await createStorage({ file, logger: sinkLogger([]) });
    expect(await reopened.namespaceFor("fresh").get("recovered")).toBe(false);
    await reopened.close();
  });
});

describe("storage serializable values", () => {
  it("rejects cyclic objects and functions with TypeError naming plugin and key", async () => {
    const file = join(tmpRoot, "serial.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const store = engine.namespaceFor("alpha");

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic["self"] = cyclic;
    await expect(store.set("cyclicKey", cyclic)).rejects.toThrow(TypeError);
    await expect(store.set("cyclicKey", cyclic)).rejects.toThrow(/"alpha"/);
    await expect(store.set("cyclicKey", cyclic)).rejects.toThrow(/"cyclicKey"/);
    await expect(store.set("fnKey", () => 1)).rejects.toThrow(TypeError);
    await expect(store.set("fnKey", () => 1)).rejects.toThrow(/"alpha"/);
    await expect(store.set("fnKey", () => 1)).rejects.toThrow(/"fnKey"/);
    await expect(store.set("undefKey", undefined)).rejects.toThrow(TypeError);

    await store.set("good", 42);
    await expect(store.set("good", cyclic)).rejects.toThrow(TypeError);
    expect(await store.get<number>("good")).toBe(42);
    expect(await engine.flushAll()).toBe(true);
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(parsed).toEqual({ version: 1, plugins: { alpha: { good: 42 } } });
    await engine.close();
  });
});

describe("storage close semantics", () => {
  it("rejects every store call after close with StorageError operation 'use after close'", async () => {
    const file = join(tmpRoot, "sealed.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const store = engine.namespaceFor("sealed");
    await store.set("x", 1);
    await engine.close();

    const calls: Array<Promise<unknown>> = [
      store.get("x"),
      store.set("y", 2),
      store.delete("x"),
      store.list(),
      store.clear(),
    ];
    for (const call of calls) {
      const error = await call.then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(error).toBeInstanceOf(StorageError);
      const storageError = error as StorageError;
      expect(storageError.fields["operation"]).toBe("use after close");
      expect(storageError.fields["namespace"]).toBe("sealed");
    }
    expect(await engine.flushAll()).toBe(false);
  });

  it("flushes pending writes on close so a reopened engine reads latest values", async () => {
    const file = join(tmpRoot, "closeflush.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const store = engine.namespaceFor("rapid");
    for (let index = 0; index < 50; index++) {
      await store.set(`k${index}`, index);
    }
    expect(await engine.close()).toBe(true);

    const reopened = await createStorage({ file, logger: sinkLogger([]) });
    const reopenedStore = reopened.namespaceFor("rapid");
    for (let index = 0; index < 50; index++) {
      expect(await reopenedStore.get<number>(`k${index}`)).toBe(index);
    }
    await reopened.close();
  });
});

describe("storage list", () => {
  it("filters by prefix and sorts lexicographically", async () => {
    const file = join(tmpRoot, "list.json");
    const engine = await createStorage({ file, logger: sinkLogger([]) });
    const store = engine.namespaceFor("listing");

    await store.set("user:2", "two");
    await store.set("user:10", "ten");
    await store.set("user:1", "one");
    await store.set("admin:x", true);
    await store.set("zebra", 26);

    expect(await store.list("user:")).toEqual([
      ["user:1", "one"],
      ["user:10", "ten"],
      ["user:2", "two"],
    ]);
    expect(await store.list("admin")).toEqual([["admin:x", true]]);
    expect(await store.list("nope")).toEqual([]);
    expect(await store.list()).toEqual([
      ["admin:x", true],
      ["user:1", "one"],
      ["user:10", "ten"],
      ["user:2", "two"],
      ["zebra", 26],
    ]);
    await engine.close();
  });
});
