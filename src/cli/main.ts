#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MockAdapter } from "../adapter/mock.js";
import type { Capabilities } from "../adapter/adapter.js";
import { loadConfig } from "../config/loader.js";
import type { LoadedConfig } from "../config/loader.js";
import { renderViolations } from "../config/render.js";
import type { AdapterType, MockAdapterOptions, PlugbotConfig } from "../config/types.js";
import { ConfigError, type ConfigViolation } from "../errors.js";
import { createDefaultLogger } from "../logging/defaultLogger.js";
import { createLogger } from "../logging/logger.js";
import type { LogLevel, Logger } from "../logging/types.js";
import { LOG_LEVELS } from "../logging/types.js";
import type { OutboundApi, PluginStore } from "../plugin/types.js";
import { catalogFromEntries } from "../router/catalog.js";
import type { CatalogCommand } from "../router/catalog.js";
import { generateMarkdownDocs } from "./docsGen.js";
import { loadPlugins } from "../runtime/loader.js";
import { startBot } from "../runtime/bot.js";
import type { RunningBot } from "../runtime/types.js";
import { systemClock } from "../runtime/systemClock.js";
import { COMMAND_HELP, ROOT_HELP, ROOT_HINT } from "./helpTexts.js";
import { parseArgv } from "./argv.js";
import { runRepl } from "./repl.js";

export interface CliStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const ADAPTER_TYPES: readonly AdapterType[] = ["mock", "transcript", "irc"];
const FORCE_EXIT_MS = 3000;
const PLUGIN_FILE_PATTERN = /\.(ts|js)$/i;
const PLUGIN_EXCLUDED_PATTERN = /(\.test\.|\.d\.(ts|js)$)/i;
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const DOCS_TITLE = "Plugbot command reference";

const DOCS_CAPABILITIES: Capabilities = {
  send: true,
  edit: true,
  delete: true,
  react: true,
  threads: true,
  typing: true,
  memberEvents: true,
  userLookup: true,
  channelLookup: true,
  roles: true,
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function configErrorText(cause: unknown): string {
  if (cause instanceof ConfigError) {
    const violations = cause.fields["violations"] as ConfigViolation[] | undefined;
    if (Array.isArray(violations)) return renderViolations(violations).join("\n");
  }
  return messageOf(cause);
}

function flagValue(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function flagTrue(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

function packageVersion(): string {
  const requirePkg = createRequire(import.meta.url);
  const pkg = requirePkg("../../package.json") as { version?: string };
  return pkg.version ?? "0.0.0";
}

function scanPluginFileNames(dir: string, onError?: (reason: string) => void): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .filter((entry) => PLUGIN_FILE_PATTERN.test(entry.name))
      .filter((entry) => !PLUGIN_EXCLUDED_PATTERN.test(entry.name))
      .filter((entry) => !entry.name.startsWith("_"))
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    onError?.(cause instanceof Error ? cause.message : String(cause));
    return [];
  }
}

function stemOf(fileName: string): string {
  return fileName.replace(PLUGIN_FILE_PATTERN, "");
}

async function loadConfigOrReport(
  file: string | undefined,
  env: Record<string, string | undefined>,
  stderr: NodeJS.WritableStream,
): Promise<LoadedConfig | null> {
  const chosenFile = file ?? env.PLUGBOT_CONFIG;
  try {
    return await loadConfig({ file: chosenFile, env });
  } catch (cause) {
    if (cause instanceof ConfigError) {
      stderr.write(`${configErrorText(cause)}\n`);
      return null;
    }
    throw cause;
  }
}

function skeletonSource(name: string): string {
  return `import { definePlugin } from "plugbot";

export default definePlugin({
  name: "${name}",
  description: "Describe what ${name} does.",

  commands: {
    echo: {
      description: "Echo back the given text.",
      args: {
        text: { type: "string", rest: true, required: true, description: "Text to echo." },
      },
      async run(ctx) {
        await ctx.reply(ctx.args.text.join(" "));
      },
    },
  },
});
`;
}

async function newCommand(
  positionals: readonly string[],
  flags: Record<string, string | boolean>,
  streams: CliStreams,
): Promise<number> {
  const name = positionals[0];
  if (name === undefined) {
    streams.stderr.write(
      `error: missing plugin name: must match ${NAME_PATTERN.source} (lowercase letters, digits, hyphens; starts with a letter)\n`,
    );
    return 1;
  }
  if (!NAME_PATTERN.test(name)) {
    streams.stderr.write(
      `error: invalid plugin name "${name}": must match ${NAME_PATTERN.source} (lowercase letters, digits, hyphens; starts with a letter)\n`,
    );
    return 1;
  }
  const dir = flagValue(flags, "--dir") ?? "plugins";
  const absDir = resolve(dir);
  const filePath = join(absDir, `${name}.ts`);
  if (existsSync(filePath)) {
    streams.stderr.write(`error: refusing to overwrite existing file: ${filePath}\n`);
    return 1;
  }
  mkdirSync(absDir, { recursive: true });
  writeFileSync(filePath, skeletonSource(name), "utf8");
  const lines = [
    `created ${filePath}`,
    "next steps:",
    `  1. open ${filePath} and replace the description`,
    "  2. point plugins.dir of your config at this directory",
    "  3. try it live: plugbot dev",
  ];
  streams.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function doctorCommand(
  file: string | undefined,
  env: Record<string, string | undefined>,
  streams: CliStreams,
): Promise<number> {
  const loaded = await loadConfigOrReport(file, env, streams.stderr);
  if (loaded === null) return 2;
  const absDir = resolve(loaded.config.plugins.dir);
  const files = scanPluginFileNames(absDir, (reason) => {
    streams.stderr.write(`warning: cannot read plugins dir: ${reason}\n`);
  });
  const lines = [
    `config ok (${loaded.loadedFromFile ?? "defaults"})`,
    `adapter: ${loaded.config.adapter.type}`,
    `plugins dir: ${absDir}`,
    `plugin candidates: ${files.length}`,
    ...files.map((fileName) => `  ${stemOf(fileName)}`),
  ];
  streams.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function rejectingOutbound(): OutboundApi {
  const reject = (): Promise<never> =>
    Promise.reject(new Error("outbound unavailable during docs generation"));
  return {
    send: reject,
    editMessage: reject,
    deleteMessage: reject,
    react: reject,
    startTyping: reject,
    getUser: reject,
    getChannel: reject,
  };
}

function idleStore(): PluginStore {
  return {
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    clear: () => Promise.resolve(),
  };
}

async function docsCommand(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  streams: CliStreams,
): Promise<number> {
  const loaded = await loadConfigOrReport(flagValue(flags, "--config"), env, streams.stderr);
  if (loaded === null) return 2;
  const config = loaded.config;
  const loadedPlugins = await loadPlugins({
    dir: resolve(config.plugins.dir),
    disabled: [...config.plugins.disabled],
    isolation: config.plugins.isolation,
    limits: {
      handlerTimeoutMs: config.limits.handlerTimeoutMs,
      breakerThreshold: config.limits.breakerThreshold,
      breakerWindowMs: config.limits.breakerWindowMs,
      breakerCooldownMs: config.limits.breakerCooldownMs,
    },
    clock: systemClock(),
    logger: createDefaultLogger({ stream: streams.stderr, level: config.logging.level }),
    outbound: rejectingOutbound(),
    storeNamespaceFor: () => idleStore(),
    capabilities: DOCS_CAPABILITIES,
    configFor: () => ({}),
  });
  try {
    const entries: CatalogCommand[] = loadedPlugins.registry.all().flatMap((runtime) =>
      runtime.manifest.commands.map((command) => ({
        plugin: runtime.name,
        path: command.path,
        description: command.description,
        aliases: command.aliases,
        args: command.args,
        permission: command.permission,
        hidden: command.hidden,
      })),
    );
    const markdown = generateMarkdownDocs(catalogFromEntries(entries), { title: DOCS_TITLE });
    const outFile = flagValue(flags, "--out");
    if (outFile !== undefined) {
      const absOut = resolve(outFile);
      mkdirSync(dirname(absOut), { recursive: true });
      writeFileSync(absOut, markdown, "utf8");
    } else {
      streams.stdout.write(markdown);
    }
    const visibleCount = entries.filter((entry) => entry.hidden !== true).length;
    streams.stderr.write(`docs generated (${visibleCount} commands)\n`);
    return 0;
  } finally {
    await loadedPlugins.disposeAll(config.limits.shutdownDrainMs);
  }
}

function validateLogLevel(value: string): LogLevel | null {
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : null;
}

interface RunFlags {
  adapter?: string;
  logLevel?: string;
  logJson: boolean;
  noColor: boolean;
}

function buildLogger(
  config: PlugbotConfig,
  flags: RunFlags,
  stdout: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): Logger {
  const level = flags.logLevel !== undefined ? (flags.logLevel as LogLevel) : config.logging.level;
  return createLogger({
    stream: stdout,
    level,
    json: flags.logJson ? true : config.logging.json,
    theme: config.logging.theme,
    color: flags.noColor ? false : undefined,
    env,
  });
}

function waitForStopSignal(bot: RunningBot): Promise<void> {
  return new Promise<void>((resolveHold) => {
    let stopping = false;
    let lastSigintAt = 0;
    const onSignal = (signal: NodeJS.Signals): void => {
      const now = Date.now();
      if (signal === "SIGINT") {
        if (now - lastSigintAt <= FORCE_EXIT_MS) {
          process.exit(1);
        }
        lastSigintAt = now;
      }
      if (stopping) return;
      stopping = true;
      void bot
        .stop()
        .catch(() => undefined)
        .then(() => {
          process.off("SIGINT", onSignal);
          process.off("SIGTERM", onSignal);
          resolveHold();
        });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

async function runCommand(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  streams: CliStreams,
): Promise<number> {
  const loaded = await loadConfigOrReport(flagValue(flags, "--config"), env, streams.stderr);
  if (loaded === null) return 2;
  let config = loaded.config;

  const adapterFlag = flagValue(flags, "--adapter");
  if (adapterFlag !== undefined) {
    if (!(ADAPTER_TYPES as readonly string[]).includes(adapterFlag)) {
      streams.stderr.write(
        `error: --adapter: expected one of ${ADAPTER_TYPES.map((value) => JSON.stringify(value)).join(", ")}, got ${JSON.stringify(adapterFlag)}\n`,
      );
      return 2;
    }
    config = structuredClone(config);
    config.adapter.type = adapterFlag as AdapterType;
  }

  const levelFlag = flagValue(flags, "--log-level");
  if (levelFlag !== undefined && validateLogLevel(levelFlag) === null) {
    streams.stderr.write(
      `error: --log-level: expected one of ${LOG_LEVELS.map((value) => JSON.stringify(value)).join(", ")}, got ${JSON.stringify(levelFlag)}\n`,
    );
    return 2;
  }

  const runFlags: RunFlags = {
    adapter: adapterFlag,
    logLevel: levelFlag,
    logJson: flagTrue(flags, "--log-json"),
    noColor: flagTrue(flags, "--no-color"),
  };
  const logger = buildLogger(config, runFlags, streams.stdout, env);

  const bot = await startBot({
    config,
    configPath: loaded.loadedFromFile ?? undefined,
    logger,
    hotReload: false,
  });
  await waitForStopSignal(bot);
  return 0;
}

async function devCommand(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined>,
  streams: CliStreams,
): Promise<number> {
  const loaded = await loadConfigOrReport(flagValue(flags, "--config"), env, streams.stderr);
  if (loaded === null) return 2;
  const config = structuredClone(loaded.config);
  config.adapter.type = "mock";
  const dirFlag = flagValue(flags, "--dir");
  if (dirFlag !== undefined) config.plugins.dir = dirFlag;

  const levelFlag = flagValue(flags, "--log-level");
  if (levelFlag !== undefined && validateLogLevel(levelFlag) === null) {
    streams.stderr.write(
      `error: --log-level: expected one of ${LOG_LEVELS.map((value) => JSON.stringify(value)).join(", ")}, got ${JSON.stringify(levelFlag)}\n`,
    );
    return 2;
  }

  const logger = buildLogger(
    config,
    {
      logLevel: levelFlag,
      logJson: flagTrue(flags, "--log-json"),
      noColor: flagTrue(flags, "--no-color"),
    },
    streams.stdout,
    env,
  );

  const clock = systemClock();
  const mock = new MockAdapter({
    ...(config.adapter.options as unknown as MockAdapterOptions),
    clock,
  });
  const bot = await startBot({
    config,
    configPath: loaded.loadedFromFile ?? undefined,
    logger,
    clock,
    adapterInstance: mock,
    hotReload: true,
  });
  try {
    await runRepl({
      bot,
      mock,
      streams: { stdin: process.stdin, stdout: streams.stdout },
      env,
      theme: config.logging.theme,
      prefix: config.commands.prefix,
    });
  } finally {
    await bot.stop();
  }
  return 0;
}

export async function runCli(
  argv: readonly string[],
  streams?: Partial<CliStreams>,
  env?: Record<string, string | undefined>,
): Promise<number> {
  const out = streams?.stdout ?? process.stdout;
  const err = streams?.stderr ?? process.stderr;
  const environ = env ?? process.env;
  const cliStreams: CliStreams = { stdout: out, stderr: err };

  try {
    const parsed = parseArgv(argv);

    if (flagTrue(parsed.flags, "--version")) {
      out.write(`${packageVersion()}\n`);
      return 0;
    }
    if (flagTrue(parsed.flags, "-h") || flagTrue(parsed.flags, "--help")) {
      out.write(ROOT_HELP);
      return 0;
    }
    if (parsed.errors.length > 0) {
      err.write(`${parsed.errors.map((line) => `error: ${line}`).join("\n")}\n`);
      return 1;
    }

    const command = parsed.command;
    if (command === null) {
      out.write(ROOT_HELP);
      return 0;
    }

    switch (command) {
      case "help": {
        const topic = parsed.positionals[0];
        if (topic === undefined) {
          out.write(ROOT_HELP);
          return 0;
        }
        const help = COMMAND_HELP[topic as keyof typeof COMMAND_HELP];
        if (help === undefined) {
          err.write(`error: unknown command "${topic}"\n${ROOT_HINT}\n`);
          return 1;
        }
        out.write(help);
        return 0;
      }
      case "new":
        return await newCommand(parsed.positionals, parsed.flags, cliStreams);
      case "doctor":
        return await doctorCommand(flagValue(parsed.flags, "--config"), environ, cliStreams);
      case "docs":
        return await docsCommand(parsed.flags, environ, cliStreams);
      case "run":
        return await runCommand(parsed.flags, environ, cliStreams);
      case "dev":
        return await devCommand(parsed.flags, environ, cliStreams);
      default:
        err.write(`error: unknown command "${command}"\n${ROOT_HINT}\n`);
        return 1;
    }
  } catch (cause) {
    err.write(`error: ${messageOf(cause)}\n`);
    return 1;
  }
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsMain) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
