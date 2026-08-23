import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/loader.js";
import { renderViolations } from "../src/config/render.js";
import { CONFIG_ENV_PREFIX, DEFAULT_CONFIG, DEFAULT_CONFIG_FILE } from "../src/config/types.js";
import { ConfigError, type ConfigViolation } from "../src/errors.js";

function fileReader(json: string): (path: string) => Promise<string> {
  return async () => json;
}

const missingFileReader = async (): Promise<string> => {
  throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
};

async function loadError(opts: Parameters<typeof loadConfig>[0]): Promise<ConfigError> {
  const settled = await loadConfig(opts).then(
    () => {
      throw new Error("expected loadConfig to reject");
    },
    (err: unknown) => err,
  );
  return settled as ConfigError;
}

function violationsOf(err: ConfigError): ConfigViolation[] {
  return err.fields["violations"] as ConfigViolation[];
}

describe("loadConfig", () => {
  it("returns defaults and null loadedFromFile when no config file is present", async () => {
    const result = await loadConfig({ env: {}, readFile: missingFileReader });
    expect(result.loadedFromFile).toBeNull();
    expect(result.config).toEqual(DEFAULT_CONFIG);
  });

  it("throws naming the path when an explicit file is missing", async () => {
    const err = await loadError({ file: "custom.json", env: {}, readFile: missingFileReader });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("config file not found: custom.json");
    expect(err.fields["source"]).toBe("custom.json");
  });

  it("reports a string where a number is expected", async () => {
    const err = await loadError({
      env: {},
      readFile: fileReader('{"limits":{"handlerTimeoutMs":"five"}}'),
    });
    expect(err.message).toContain('limits.handlerTimeoutMs: expected a number, got "five"');
  });

  it("reports a non-positive number against a positive field", async () => {
    const err = await loadError({
      env: {},
      readFile: fileReader('{"limits":{"breakerThreshold":-2}}'),
    });
    expect(err.message).toContain("limits.breakerThreshold: expected a positive number, got -2");
  });

  it("lists every enum value for an unknown adapter type", async () => {
    const err = await loadError({ env: {}, readFile: fileReader('{"adapter":{"type":"slack"}}') });
    expect(err.message).toContain(
      'adapter.type: expected one of "mock", "transcript", "irc", got "slack"',
    );
  });

  it("suggests the nearest known key for a typoed path", async () => {
    const err = await loadError({ env: {}, readFile: fileReader('{"pluginsz":{"dir":"bots"}}') });
    const violations = violationsOf(err);
    expect(violations[0]?.key).toBe("pluginsz.dir");
    expect(err.message).toContain('did you mean "plugins.dir"?');
  });

  it("omits the suggestion line for a far-off unknown key", async () => {
    const err = await loadError({ env: {}, readFile: fileReader('{"zzzzzz":true}') });
    expect(err.message).toContain("unknown key");
    expect(err.message).not.toContain("did you mean");
  });

  it("reports an explicit null as a missing required key", async () => {
    const err = await loadError({ env: {}, readFile: fileReader('{"storage":{"file":null}}') });
    expect(err.message).toContain("storage.file: missing required key, but it is absent");
  });

  it("lets an env override win over the file value", async () => {
    const result = await loadConfig({
      env: { [`${CONFIG_ENV_PREFIX}LOGGING__LEVEL`]: "debug" },
      readFile: fileReader('{"logging":{"level":"warn"}}'),
    });
    expect(result.config.logging.level).toBe("debug");
  });

  it("sources a bad env number to the env var name", async () => {
    const err = await loadError({
      env: { PLUGBOT_LIMITS__HANDLERTIMEOUTMS: "abc" },
      readFile: missingFileReader,
    });
    expect(err.fields["source"]).toBe("env");
    expect(err.message).toContain('limits.handlerTimeoutMs: expected a number, got "abc"');
    expect(err.message).toContain('at env PLUGBOT_LIMITS__HANDLERTIMEOUTMS  key "limits.handlerTimeoutMs"');
  });

  it("parses PLUGBOT_ADAPTER__OPTIONS as JSON into adapter.options", async () => {
    const result = await loadConfig({
      env: { PLUGBOT_ADAPTER__OPTIONS: '{"server":"irc.example.net","port":6667}' },
      readFile: missingFileReader,
    });
    expect(result.config.adapter.options).toEqual({ server: "irc.example.net", port: 6667 });
  });

  it("rejects invalid JSON in PLUGBOT_ADAPTER__OPTIONS with an env-sourced violation", async () => {
    const err = await loadError({
      env: { PLUGBOT_ADAPTER__OPTIONS: "{oops" },
      readFile: missingFileReader,
    });
    expect(err.message).toContain("adapter.options: valid JSON object, got \"{oops\"");
    expect(err.message).toContain('at env PLUGBOT_ADAPTER__OPTIONS  key "adapter.options"');
  });

  it("suggests known keys for typoed env vars", async () => {
    const err = await loadError({
      env: { PLUGBOT_PLUGINZ__DIR: "bots" },
      readFile: missingFileReader,
    });
    expect(err.message).toContain('at env PLUGBOT_PLUGINZ__DIR  key "pluginz.dir"');
    expect(err.message).toContain('did you mean "plugins.dir"?');
  });

  it("reports all violations sorted: unknown first, wrong-type second, missing last", async () => {
    const raw = '{"zzzzzz":1,"limits":{"handlerTimeoutMs":"five"},"storage":{"file":null}}';
    const err = await loadError({ env: {}, readFile: fileReader(raw) });
    const lines = err.message.split("\n");
    const errorLines = lines.filter((line) => line.startsWith("config error: "));
    expect(errorLines.length).toBe(3);
    const unknownAt = lines.findIndex((line) => line.startsWith("config error: zzzzzz:"));
    const typeAt = lines.findIndex((line) =>
      line.startsWith("config error: limits.handlerTimeoutMs:"),
    );
    const missingAt = lines.findIndex((line) => line.startsWith("config error: storage.file:"));
    expect(unknownAt).toBeGreaterThanOrEqual(0);
    expect(typeAt).toBeGreaterThan(unknownAt);
    expect(missingAt).toBeGreaterThan(typeAt);
  });

  it("passes a valid full config through unchanged including adapter.options", async () => {
    const expected = {
      adapter: {
        type: "irc",
        options: {
          server: "irc.libera.chat",
          port: 6697,
          reconnect: { initialDelayMs: 500, maxDelayMs: 8000 },
        },
      },
      bot: { username: "forge-bot" },
      plugins: { dir: "extensions", disabled: ["dice"], isolation: "inline" },
      commands: { prefix: "?", mentionAliases: ["plug"] },
      permissions: { adminUserIds: ["u1"], denyByDefaultAdmin: true },
      storage: { file: "store/state.json" },
      logging: { level: "warn", json: true, theme: "light" },
      limits: {
        handlerTimeoutMs: 2500,
        breakerThreshold: 3,
        breakerWindowMs: 30000,
        breakerCooldownMs: 15000,
        userCommandsPerMinute: 10,
        shutdownDrainMs: 4000,
      },
      pluginConfigs: { dice: { sides: 20 } },
    };
    const result = await loadConfig({ env: {}, readFile: fileReader(JSON.stringify(expected)) });
    expect(result.config).toEqual(expected);
    expect(result.loadedFromFile).toBe(DEFAULT_CONFIG_FILE);
  });
});

describe("renderViolations", () => {
  it("renders the fixed three-violation fixture character-exactly, sorted", () => {
    const fixture: ConfigViolation[] = [
      { key: "storage.file", expectation: "missing required key", actual: "", source: "config.json" },
      { key: "pluginsz.dir", expectation: "unknown key", actual: "plugins.dir", source: "config.json" },
      {
        key: "adapter.type",
        expectation: 'expected one of "mock", "transcript", "irc"',
        actual: '"slack"',
        source: "PLUGBOT_ADAPTER__TYPE",
      },
    ];
    expect(renderViolations(fixture)).toEqual([
      "config error: pluginsz.dir: unknown key",
      '  at config.json  key "pluginsz.dir"',
      '  did you mean "plugins.dir"?',
      'config error: adapter.type: expected one of "mock", "transcript", "irc", got "slack"',
      '  at env PLUGBOT_ADAPTER__TYPE  key "adapter.type"',
      "config error: storage.file: missing required key, but it is absent",
      '  at config.json  key "storage.file"',
    ]);
  });
});
