import { describe, expect, it } from "vitest";

import { createLogger, decideColour, formatRecord } from "../src/logging/logger.js";
import type { LogRecord } from "../src/logging/types.js";

function makeRecord(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    time: 1755864000000,
    level: "info",
    name: "core",
    msg: "ready",
    fields: {},
    ...overrides,
  };
}

const HUMAN_OFF = { json: false, theme: "dark" as const, colorEnabled: false };

interface CapturedStream {
  lines: string[];
  readonly isTTY: boolean;
  write(chunk: string): void;
}

function capturedStream(isTTY: boolean): CapturedStream {
  const lines: string[] = [];
  return {
    lines,
    isTTY,
    write(chunk: string): void {
      lines.push(chunk);
    },
  };
}

describe("formatRecord human mode", () => {
  it("matches the anchored shape for five-letter levels", () => {
    const line = formatRecord(makeRecord({ level: "debug" }), HUMAN_OFF);
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} [A-Z]{5} .{1,12} .+$/);
    const errorLine = formatRecord(makeRecord({ level: "error", msg: "boom" }), HUMAN_OFF);
    expect(errorLine).toMatch(/^\d{2}:\d{2}:\d{2} [A-Z]{5} .{1,12} .+$/);
  });

  it("pads the level word to exactly five characters", () => {
    expect(formatRecord(makeRecord({ level: "info" }), HUMAN_OFF)).toMatch(
      /^\d{2}:\d{2}:\d{2} INFO {2}/,
    );
    expect(formatRecord(makeRecord({ level: "warn" }), HUMAN_OFF)).toMatch(
      /^\d{2}:\d{2}:\d{2} WARN {2}/,
    );
    expect(formatRecord(makeRecord({ level: "error" }), HUMAN_OFF)).toMatch(
      /^\d{2}:\d{2}:\d{2} ERROR /,
    );
    expect(formatRecord(makeRecord({ level: "debug" }), HUMAN_OFF)).toMatch(
      /^\d{2}:\d{2}:\d{2} DEBUG /,
    );
  });

  it("left-aligns and pads the name to twelve characters", () => {
    const line = formatRecord(makeRecord({ name: "core" }), HUMAN_OFF);
    expect(line).toContain("core         ready");
    const longName = formatRecord(
      makeRecord({ name: "plugin-name-long", msg: "hello" }),
      HUMAN_OFF,
    );
    expect(longName).toContain("plugin-name-long hello");
  });

  it("quotes string field values containing spaces and leaves plain ones bare", () => {
    const line = formatRecord(
      makeRecord({ msg: "m", fields: { text: "hello world", mode: "fast", count: 3 } }),
      HUMAN_OFF,
    );
    expect(line).toContain('text="hello world"');
    expect(line).toContain("mode=fast");
    expect(line).toContain("count=3");
  });

  it("omits undefined fields entirely and renders null as null", () => {
    const line = formatRecord(
      makeRecord({ msg: "m", fields: { present: "yes", absent: undefined, owner: null } }),
      HUMAN_OFF,
    );
    expect(line).not.toContain("absent");
    expect(line).toContain("owner=null");
    expect(line).toContain("present=yes");
  });

  it("renders Error values as their message only", () => {
    const line = formatRecord(
      makeRecord({ msg: "failed", fields: { error: new Error("x is not defined") } }),
      HUMAN_OFF,
    );
    expect(line).toContain("error=x is not defined");
    expect(line).not.toContain("Error:");
  });

  it("renders arrays and objects as compact JSON", () => {
    const line = formatRecord(
      makeRecord({ msg: "m", fields: { tags: ["a", "b"], nested: { k: 1 } } }),
      HUMAN_OFF,
    );
    expect(line).toContain('tags=["a","b"]');
    expect(line).toContain('nested={"k":1}');
  });
});

describe("child loggers", () => {
  it("dot-joins child names", () => {
    const seen: LogRecord[] = [];
    const logger = createLogger({
      sink: (record) => seen.push(record),
      env: {},
    });
    logger.child("router").child("sub").info("dispatch");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("router.sub");
  });

  it("filters records below the threshold before formatting", () => {
    const stream = capturedStream(false);
    const logger = createLogger({ stream, level: "warn", env: {} });
    logger.info("quiet");
    logger.warn("loud");
    expect(stream.lines).toHaveLength(1);
    expect(stream.lines[0]).toContain("loud");
  });
});

describe("formatRecord json mode", () => {
  it("emits parseable lines with time/level/name/msg plus flattened fields", () => {
    const line = formatRecord(
      makeRecord({ fields: { adapter: "mock", plugins: 4 } }),
      { json: true, theme: "dark", colorEnabled: false },
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["level"]).toBe("info");
    expect(parsed["name"]).toBe("core");
    expect(parsed["msg"]).toBe("ready");
    expect(parsed["adapter"]).toBe("mock");
    expect(parsed["plugins"]).toBe(4);
    const time = new Date(parsed["time"] as string);
    expect(Number.isNaN(time.getTime())).toBe(false);
    expect((parsed["time"] as string).endsWith("Z")).toBe(true);
  });

  it("never emits ANSI escapes in JSON mode even when colour requested", () => {
    const stream = capturedStream(true);
    const logger = createLogger({ stream, json: true, color: true, env: {} });
    logger.warn("coloured?", { with: "space value" });
    logger.error("plain");
    expect(stream.lines.length).toBeGreaterThan(0);
    for (const line of stream.lines) {
      expect(line.includes("\u001B")).toBe(false);
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});

describe("colour decision", () => {
  it("enables colour on an explicit true even without TTY", () => {
    const stream = capturedStream(false);
    const logger = createLogger({ stream, color: true, env: {} });
    logger.info("ready");
    expect(stream.lines.join("")).toContain("\u001B[");
  });

  it("keeps colour off when the stream is not a TTY and nothing forces it", () => {
    const stream = capturedStream(false);
    const logger = createLogger({ stream, env: {} });
    logger.info("ready");
    expect(stream.lines.join("")).not.toContain("\u001B[");
  });

  it("enables colour when the stream is a TTY", () => {
    const stream = capturedStream(true);
    const logger = createLogger({ stream, env: {} });
    logger.info("ready");
    expect(stream.lines.join("")).toContain("\u001B[");
  });

  it("NO_COLOR presence (any value, including empty) disables colour regardless of TTY", () => {
    const stream = capturedStream(true);
    const logger = createLogger({ stream, env: { NO_COLOR: "" } });
    logger.info("ready");
    expect(stream.lines.join("")).not.toContain("\u001B[");
  });

  it("explicit color:false overrides a TTY", () => {
    const stream = capturedStream(true);
    const logger = createLogger({ stream, color: false, env: {} });
    logger.info("ready");
    expect(stream.lines.join("")).not.toContain("\u001B[");
  });

  it("explicit color:true wins over NO_COLOR", () => {
    expect(decideColour(undefined, true, { NO_COLOR: "1" })).toBe(true);
  });

  it("decideColour treats NO_COLOR present-but-empty as disabled", () => {
    const ttyStream = { write: () => undefined, isTTY: true } as unknown as { write(s: string): void };
    const plainStream = { write: () => undefined } as unknown as { write(s: string): void };
    expect(decideColour(ttyStream, undefined, { NO_COLOR: "" })).toBe(false);
    expect(decideColour(plainStream, undefined, {})).toBe(false);
    expect(decideColour(ttyStream, undefined, {})).toBe(true);
  });
});

describe("themes", () => {
  it("dark and light produce different escape sequences for info", () => {
    const dark = formatRecord(makeRecord(), { json: false, theme: "dark", colorEnabled: true });
    const light = formatRecord(makeRecord(), { json: false, theme: "light", colorEnabled: true });
    expect(dark).toContain("\u001B[96m");
    expect(light).toContain("\u001B[34m");
    expect(dark).not.toBe(light);
  });

  it("only emits codes from the 16-colour safe range", () => {
    const outputs: string[] = [];
    for (const theme of ["dark", "light"] as const) {
      for (const level of ["debug", "info", "warn", "error"] as const) {
        outputs.push(formatRecord(makeRecord({ level }), { json: false, theme, colorEnabled: true }));
      }
    }
    const pattern = /\u001B\[(\d{1,2})m/g;
    let matchCount = 0;
    for (const output of outputs) {
      for (const match of output.matchAll(pattern)) {
        matchCount += 1;
        const code = Number(match[1]);
        expect(code === 0 || (code >= 30 && code <= 97)).toBe(true);
      }
    }
    expect(matchCount).toBeGreaterThan(0);
  });

  it("colours only the level word and the logger name", () => {
    const line = formatRecord(
      makeRecord({ fields: { adapter: "mock" } }),
      { json: false, theme: "dark", colorEnabled: true },
    );
    const escapeCount = line.split("\u001B[").length - 1;
    expect(escapeCount).toBe(4);
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} \u001B\[96m/);
    expect(line.endsWith("adapter=mock")).toBe(true);
  });
});

describe("formatRecord purity", () => {
  it("returns identical output for identical input without mutating the record", () => {
    const record = makeRecord({ fields: { key: "value value", n: 1 } });
    const snapshot = structuredClone(record.fields);
    const first = formatRecord(record, HUMAN_OFF);
    const second = formatRecord(record, HUMAN_OFF);
    expect(first).toBe(second);
    expect(record.fields).toEqual(snapshot);
  });
});
