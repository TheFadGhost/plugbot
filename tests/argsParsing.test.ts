import { describe, expect, it } from "vitest";
import { parseArguments } from "../src/router/argsParser.js";
import { tokenizeCommandLine } from "../src/router/tokenizer.js";
import type { ArgsSchema } from "../src/plugin/types.js";

describe("tokenizeCommandLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommandLine("poll create  my title\tagain")).toEqual({
      tokens: ["poll", "create", "my", "title", "again"],
      problems: [],
    });
  });

  it("groups with double and single quotes", () => {
    expect(tokenizeCommandLine('say "hello world" ok')).toEqual({
      tokens: ["say", "hello world", "ok"],
      problems: [],
    });
    expect(tokenizeCommandLine("say 'two  spaces' done")).toEqual({
      tokens: ["say", "two  spaces", "done"],
      problems: [],
    });
  });

  it("concatenates mixed adjacent segments", () => {
    expect(tokenizeCommandLine(`he said "hi there"'!'ok`)).toEqual({
      tokens: ["he", "said", "hi there!ok"],
      problems: [],
    });
  });

  it("keeps single quotes fully literal", () => {
    expect(tokenizeCommandLine("'a\\\"b'")).toEqual({ tokens: ['a\\"b'], problems: [] });
    expect(tokenizeCommandLine('\'"double"\'')).toEqual({ tokens: ['"double"'], problems: [] });
  });

  it("escapes any next char outside quotes", () => {
    expect(tokenizeCommandLine("a\\ b\\\\c")).toEqual({ tokens: ["a b\\c"], problems: [] });
    expect(tokenizeCommandLine('\\!ping')).toEqual({ tokens: ["!ping"], problems: [] });
  });

  it("escapes quote and backslash inside double quotes only", () => {
    expect(tokenizeCommandLine('"a \\"quoted\\" part"')).toEqual({
      tokens: ['a "quoted" part'],
      problems: [],
    });
    expect(tokenizeCommandLine('"C:\\\\path"')).toEqual({ tokens: ["C:\\path"], problems: [] });
    expect(tokenizeCommandLine('"a\\nb"')).toEqual({ tokens: ["a\\nb"], problems: [] });
  });

  it("reports unterminated quotes and keeps collected tokens", () => {
    expect(tokenizeCommandLine('foo "bar baz')).toEqual({
      tokens: ["foo", "bar baz"],
      problems: ["unterminated quote"],
    });
    expect(tokenizeCommandLine("it's fine")).toEqual({
      tokens: ["its fine"],
      problems: ["unterminated quote"],
    });
  });

  it("preserves empty quoted tokens", () => {
    expect(tokenizeCommandLine('a "" b')).toEqual({ tokens: ["a", "", "b"], problems: [] });
    expect(tokenizeCommandLine("''")).toEqual({ tokens: [""], problems: [] });
  });
});

describe("parseArguments numbers", () => {
  const schema: ArgsSchema = { count: { type: "number", required: true } };

  it("accepts integers, negatives, decimals", () => {
    expect(parseArguments(schema, ["42"]).args).toEqual({ count: 42 });
    expect(parseArguments(schema, ["-3.5"]).args).toEqual({ count: -3.5 });
  });

  it("rejects NaN words, Infinity, empty strings", () => {
    for (const bad of ["abc", "Infinity", "-Infinity", ""]) {
      const outcome = parseArguments(schema, [bad]);
      expect(outcome.problems).toEqual([`invalid number "${bad}" for count`]);
      expect(outcome.args).toEqual({});
    }
  });
});

describe("parseArguments durations", () => {
  const schema: ArgsSchema = { wait: { type: "duration", required: true } };

  it("converts every unit to milliseconds", () => {
    expect(parseArguments(schema, ["250ms"]).args).toEqual({ wait: 250 });
    expect(parseArguments(schema, ["90s"]).args).toEqual({ wait: 90_000 });
    expect(parseArguments(schema, ["5m"]).args).toEqual({ wait: 300_000 });
    expect(parseArguments(schema, ["2h"]).args).toEqual({ wait: 7_200_000 });
    expect(parseArguments(schema, ["3d"]).args).toEqual({ wait: 259_200_000 });
  });

  it("accepts fractions and is case-insensitive", () => {
    expect(parseArguments(schema, ["1.5h"]).args).toEqual({ wait: 5_400_000 });
    expect(parseArguments(schema, ["90S"]).args).toEqual({ wait: 90_000 });
    expect(parseArguments(schema, ["5M"]).args).toEqual({ wait: 300_000 });
    expect(parseArguments(schema, ["100MS"]).args).toEqual({ wait: 100 });
  });

  it("rejects malformed values with a hint", () => {
    for (const bad of ["5", "m", "5x", "1..5s", ""]) {
      const outcome = parseArguments(schema, [bad]);
      expect(outcome.problems[0]).toBe(`invalid duration "${bad}" for wait, like "90s" or "5m"`);
    }
  });
});

describe("parseArguments booleans", () => {
  const schema: ArgsSchema = { flag: { type: "boolean", required: true } };

  it("accepts the six canonical forms case-insensitively", () => {
    expect(parseArguments(schema, ["true"]).args).toEqual({ flag: true });
    expect(parseArguments(schema, ["YES"]).args).toEqual({ flag: true });
    expect(parseArguments(schema, ["On"]).args).toEqual({ flag: true });
    expect(parseArguments(schema, ["false"]).args).toEqual({ flag: false });
    expect(parseArguments(schema, ["No"]).args).toEqual({ flag: false });
    expect(parseArguments(schema, ["OFF"]).args).toEqual({ flag: false });
  });

  it("rejects anything else", () => {
    const outcome = parseArguments(schema, ["maybe"]);
    expect(outcome.problems).toEqual(['invalid boolean "maybe" for flag']);
  });
});

describe("parseArguments choices", () => {
  it("passes members and rejects outsiders naming the allowed set", () => {
    const schema: ArgsSchema = { env: { type: "string", choices: ["dev", "prod"] } };
    expect(parseArguments(schema, ["dev"]).args).toEqual({ env: "dev" });
    const outcome = parseArguments(schema, ["staging"]);
    expect(outcome.problems).toEqual(['value "staging" for env must be one of: dev|prod']);
  });

  it("compares numerically after coercion", () => {
    const schema: ArgsSchema = { level: { type: "number", choices: [1, 2, 3] } };
    expect(parseArguments(schema, ["2"]).args).toEqual({ level: 2 });
    expect(parseArguments(schema, ["9"]).problems).toHaveLength(1);
  });
});

describe("parseArguments bounds", () => {
  const schema: ArgsSchema = { level: { type: "number", min: 1, max: 10, required: true } };

  it("treats min and max as inclusive", () => {
    expect(parseArguments(schema, ["1"]).args).toEqual({ level: 1 });
    expect(parseArguments(schema, ["10"]).args).toEqual({ level: 10 });
  });

  it("reports violations on either side", () => {
    expect(parseArguments(schema, ["0"]).problems).toEqual(["value 0 for level must be at least 1"]);
    expect(parseArguments(schema, ["11"]).problems).toEqual(["value 11 for level must be at most 10"]);
  });

  it("bounds durations too", () => {
    const timed: ArgsSchema = { wait: { type: "duration", max: 60_000, required: true } };
    expect(parseArguments(timed, ["1m"]).args).toEqual({ wait: 60_000 });
    expect(parseArguments(timed, ["1h"]).problems).toEqual(["value 3600000 for wait must be at most 60000"]);
  });
});

describe("parseArguments defaults", () => {
  it("applies defaults for absent optional keys", () => {
    const schema: ArgsSchema = {
      duration: { type: "duration", default: "5m" },
      label: { type: "string", default: "none" },
      enabled: { type: "boolean", default: false },
    };
    expect(parseArguments(schema, []).args).toEqual({
      duration: 300_000,
      label: "none",
      enabled: false,
    });
  });

  it("lets provided values override defaults", () => {
    const schema: ArgsSchema = { duration: { type: "duration", default: "5m" } };
    expect(parseArguments(schema, ["10s"]).args).toEqual({ duration: 10_000 });
  });

  it("omits absent keys without defaults", () => {
    const schema: ArgsSchema = { note: { type: "string" } };
    const outcome = parseArguments(schema, []);
    expect(outcome.args).toEqual({});
    expect(outcome.problems).toEqual([]);
  });
});

describe("parseArguments required", () => {
  it("names the missing key", () => {
    const schema: ArgsSchema = { title: { type: "string", required: true } };
    const outcome = parseArguments(schema, []);
    expect(outcome.problems).toEqual(["missing required argument title"]);
  });

  it("collects every missing key in declaration order", () => {
    const schema: ArgsSchema = {
      title: { type: "string", required: true },
      body: { type: "string", required: true },
    };
    const outcome = parseArguments(schema, []);
    expect(outcome.problems).toEqual([
      "missing required argument title",
      "missing required argument body",
    ]);
  });
});

describe("parseArguments rest", () => {
  it("captures multiple remaining tokens verbatim", () => {
    const schema: ArgsSchema = { tags: { type: "string", rest: true } };
    expect(parseArguments(schema, ["a", "b c", '"d"']).args).toEqual({
      tags: ["a", "b c", '"d"'],
    });
  });

  it("captures zero tokens as an empty array", () => {
    const schema: ArgsSchema = { tags: { type: "string", rest: true } };
    expect(parseArguments(schema, []).args).toEqual({ tags: [] });
  });

  it("flags an empty required rest as missing", () => {
    const schema: ArgsSchema = { body: { type: "string", rest: true, required: true } };
    const outcome = parseArguments(schema, []);
    expect(outcome.problems).toEqual(["missing required argument body"]);
    expect(outcome.args).toEqual({ body: [] });
  });

  it("rejects a rest argument that is not last", () => {
    const schema: ArgsSchema = {
      tags: { type: "string", rest: true },
      extra: { type: "string" },
    };
    const outcome = parseArguments(schema, ["a", "b"]);
    expect(outcome.problems).toEqual(["rest argument must be last"]);
    expect(outcome.args).toEqual({});
  });
});

describe("parseArguments leftovers", () => {
  it("names each unexpected token individually", () => {
    const schema: ArgsSchema = { one: { type: "string", required: true } };
    const outcome = parseArguments(schema, ["x", "y", "z"]);
    expect(outcome.problems).toEqual(['unexpected argument "y"', 'unexpected argument "z"']);
    expect(outcome.args).toEqual({ one: "x" });
  });

  it("validates extras even when no schema is declared", () => {
    const outcome = parseArguments(undefined, ["a", "b"]);
    expect(outcome.args).toEqual({});
    expect(outcome.problems).toEqual(['unexpected argument "a"', 'unexpected argument "b"']);
  });
});

describe("parseArguments strings", () => {
  it("passes strings through including empty tokens", () => {
    const schema: ArgsSchema = { label: { type: "string", required: true }, spare: { type: "string" } };
    const outcome = parseArguments(schema, ["", "kept"]);
    expect(outcome.args).toEqual({ label: "", spare: "kept" });
    expect(outcome.problems).toEqual([]);
  });
});
