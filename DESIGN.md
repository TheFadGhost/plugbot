# DESIGN.md

Design precedes implementation. Every module is built to this document. When
code and document disagree, one of them is wrong; fix it before moving on.

## Point of view

Plugbot is a quiet, unsurprising framework. A competent developer should be able
to predict what a piece of code does from its declaration alone: if a plugin
declares a command, the bot answers it; if a handler throws, the bot logs which
plugin and handler failed and keeps serving everyone else; if an adapter lacks
a capability, calling it fails loudly instead of doing nothing. There is no
magic: no decorators that register themselves as side effects of importing, no
string-keyed service locator, no global mutable state that a plugin can reach
around. The common case is short; the advanced case is possible; nothing is
required that the trivial case does not use. The interface is the plugin API,
the CLI, and the log output - that is where the taste lives, so those three get
the most attention and the least ornament.

## 1. Plugin authoring API

Principle: the common case is short, the advanced case is possible, no required
boilerplate, no string-keyed lookup where a typed object will do. A plugin is
one exported `definePlugin({...})` call. Everything except `name` is optional;
a plugin that declares nothing still loads, initialises, and shuts down cleanly.

### Minimal plugin, complete

```ts
import { definePlugin } from "plugbot";

export default definePlugin({
  name: "ping",
  description: "Answers ping with pong.",

  commands: {
    ping: {
      description: "Reply with pong.",
      async run(ctx) {
        await ctx.reply("pong");
      },
    },
  },
});
```

That is a complete, loadable, testable file. Nothing else is required. No
registration call, no manifest, no config entry.

### Complex plugin, complete

```ts
import { definePlugin } from "plugbot";

export default definePlugin({
  name: "standup",
  version: "1.0.0",
  description: "Collects standup notes and posts a daily digest.",

  init(ctx) {
    ctx.logger.info("loaded", { channels: ctx.config.channels?.length ?? 0 });
  },

  async shutdown() {
    // flush anything held in memory; storage is flushed by the framework
  },

  configSchema: {
    digestChannel: { type: "string", required: true },
    postTime: { type: "string", default: "09:00" },
  },
  commands: {
    note: {
      description: "Record a standup note.",
      aliases: ["n"],
      args: {
        body: { type: "string", rest: true, required: true, description: "Note text." },
      },
      async run(ctx) {
        const notes = (await ctx.store.get<string[]>("notes")) ?? [];
        notes.push(`${ctx.message.author.username}: ${ctx.args.body}`);
        await ctx.store.set("notes", notes);
        await ctx.react("+1");
      },

      subcommands: {
        clear: {
          description: "Clear today's notes.",
          permission: "admin",
          async run(ctx) {
            await ctx.store.set("notes", []);
            await ctx.reply("Notes cleared.");
          },
        },
      },
    },
  },

  listeners: [
    {
      name: "thanks-watcher",
      pattern: /\bthank(s| you)\b/i,
      cooldownMs: 60_000,
      async run(ctx) {
        await ctx.react("+1");
      },
    },
  ],

  jobs: [
    {
      name: "digest",
      schedule: { dailyAt: "09:00" },        // or { everyMs: 3_600_000 }
      description: "Post the digest.",
      async run(ctx) {
        const notes = (await ctx.store.get<string[]>("notes")) ?? [];
        if (!ctx.capabilities.send) return;
        await ctx.bot.send(ctx.config.digestChannel, notes.join("\n") || "No notes today.");
      },
    },
  ],

  events: {
    memberJoin: async (ctx) => {
      await ctx.bot.send(ctx.event.channelId, `Welcome, <${ctx.event.userId}>.`);
    },
  },
});
```

### API rules committed here

- `definePlugin` is an identity function. Its only job is type inference and
  giving editors a place to hang documentation. It has no side effects.
- A command with subcommands and no `run` is a pure group: invoking it prints
  guidance instead of erroring. Aliases resolve within their parent command's
  scope (`poll vote` aliased `v` is reachable as `!poll v`, not bare `!v`).
- Configuration reaches plugins as a validated typed object (`ctx.config`
  shaped by `configSchema`). Values come from the top-level `pluginConfigs`
  config section keyed by plugin name; declared defaults apply, types are
  enforced host-side, and unknown or missing keys fail the load naming the
  exact key. Plugins never read environment variables or files.
- Bundled example plugins use plain object specs with type-only imports;
  they execute inside worker threads where package self-imports cannot
  resolve. Published plugins installed from npm import `{ definePlugin }`
  from `"plugbot"` normally.
- Cross-plugin communication does not exist in v1. If two plugins need to
  talk, they talk through shared listener on the same platform messages.
  This is deliberate.
- Time comes from an injected clock. Scheduled jobs and timeouts consult it
  so tests can advance time deterministically. Handler invocations carry
  fresh time across the worker boundary on every call.
- Handlers receive `ctx.signal` (AbortSignal). It aborts on handler timeout,
  plugin reload, and shutdown. Long loops check it.

### Contexts

| Context | Received by | Members |
| --- | --- | --- |
| `PluginContext` | `init` | `name, logger, store, config, capabilities, clock, signal` |
| `CommandContext` | command `run` | `message, args, rawArgs, commandPath, reply, react, typing, bot, store, logger, capabilities, signal` |
| `ListenerContext` | listener `run` | `message, match, reply, react, typing, bot, store, logger, capabilities, signal` |
| `JobContext` | job `run` | `scheduledFor, bot, store, logger, capabilities, signal` |
| `EventContext` | event hooks | `event, bot, store, logger, capabilities, signal` |

`reply(text)` sends to the channel/thread the triggering message came from.
`bot.send(channelId, text)` sends anywhere. Both return the sent-message
reference so plugins can later edit or delete their own output.

## 2. Naming conventions

Applied to every module, without exception.

- Types, interfaces, classes: `PascalCase`. Functions, variables, properties:
  `camelCase`. True constants: `SCREAMING_SNAKE_CASE`. File names: `camelCase`,
  named after their primary export.
- Methods are verb-first: `send`, `editMessage`, `deleteMessage`, `react`,
  `startTyping`, `getUser`, `getChannel`, `resolveRoles`.
- Events are lowerCamelCase occurrences: `message`, `memberJoin`,
  `memberLeave`. Event handler properties share the event name exactly.
- Banned as identifiers anywhere in the codebase: `data`, `info` (except the
  log level), `manager`, `helper`, `utils`, `misc`, `handle`, `processor`.
  A name states what the thing is: `storage`, `router`, `scheduler`,
  `registry`, `breaker`.
- Adapters are named after their platform in one lowercase word: `mock`,
  `transcript`, `irc`.
- Error classes end in `Error`; middleware factories end in `Middleware`.

## 3. Error taxonomy

The rule in one line: **startup throws, inbound logs.** Problems detected while
becoming ready stop the process with a specific message; problems detected while
serving messages are contained, logged with attribution, and never propagate.

| Class | Raised when | Boundary behaviour |
| --- | --- | --- |
| `ConfigError` | Config file/env fails validation | Thrown at startup; process exits 2; message names the exact key. |
| `CapabilityError` | Code calls an operation the adapter declared unsupported | Rejected promise to the caller; names adapter, operation; suggests checking `capabilities`. |
| `AdapterOperationError` | Transport-level failure during an adapter call | Rejected promise to the caller; wrapped with adapter name and operation. |
| `PluginLoadError` | Plugin file cannot be imported or its shape is wrong | Caught by loader; logged error naming file and reason; bot starts without that plugin. |
| `HandlerTimeoutError` | Handler exceeded its timeout | Worker terminated and respawned lazily; logged error naming plugin, handler, elapsed ms; counts toward the breaker. |
| `HandlerError` | Any throw/rejection inside a handler | Contained at the isolation boundary; logged warning naming plugin and handler; stack shows only plugin frames; counts toward the breaker. |
| `CircuitOpenError` | Invocation attempted while a plugin's breaker is open | Router replies in-channel with a short unavailability notice; logged once at open and once at close. |
| `ArgumentValidationError` | Arguments fail the declared schema | Never escapes the router: converted into a generated usage reply in-channel; logged debug. |
| `PermissionDeniedError` | Authorization middleware rejects | Generic in-channel denial reply (no role enumeration); logged info naming user and command. |
| `RateLimitError` | Limiter middleware rejects | In-channel reply including retry seconds; logged debug. |
| `StorageError` | Read/write failure in persistent storage | Rejected promise to the owning plugin; reads fall back to the `.bak` copy, then empty; writes are retried once then logged warn. |

Distinguishing your bug from ours: every error carries a `code` string. Codes
prefixed `PLUGIN_` are the plugin author's fault (`PLUGIN_HANDLER_FAILED`,
`PLUGIN_TIMEOUT`, `PLUGIN_LOAD_FAILED`). Codes prefixed `CONFIG_`, `ADAPTER_`,
`COMMAND_`, `PERMISSION_`, `RATE_LIMIT_`, `STORAGE_` belong to the framework or
platform layer. Stack traces shown for `PLUGIN_*` errors contain frames from
plugin sources only; framework internals are filtered out of the rendered log
(the full stack stays available at debug level).

## 4. Logging

Two output modes, one source of truth. Every record has: `time`, `level`,
`name`, `msg`, zero or more structured fields.

Levels: `debug`, `info`, `warn`, `error`. Default level `info`.

Names are dotted paths: `core`, `router`, `adapter:mock`, `plugin:poll`,
`plugin:poll:command:create`.

### Human mode (default on a TTY)

```
14:03:22 INFO  core          bot ready adapter=mock plugins=4
14:03:23 DEBUG router        dispatch commandPath=poll.create user=alice
14:03:24 WARN  plugin:dice   handler failed handler=roll error=x is not defined
```

Format: `HH:MM:SS LEVEL NAME MESSAGE key=value ...`. LEVEL is upper-case padded
to five characters. NAME is left-aligned padded to twelve. Values containing
spaces are double-quoted.

Colour roles - the only places colour ever appears: the level word, the logger
name, and nothing else. Timestamps and field keys render dim in both themes.

### Machine mode

Enabled by `--log-json`, `logging.json: true`, or `PLUGBOT_LOG_JSON=1`. One JSON
object per line, no colour regardless of TTY:

```json
{"time":"2026-08-22T14:03:22.512Z","level":"info","name":"core","msg":"bot ready","adapter":"mock","plugins":4}
```

Both modes are covered by tests: a fixture run must parse line-by-line as JSON
in machine mode and match the human regex in human mode.

### Colour rules

- `NO_COLOR` environment variable (any value) disables colour.
- `--no-color` flag disables colour and overrides config.
- stdout not a TTY disables colour automatically.
- Only the 16 standard ANSI colours are used, so output renders correctly on a
  16-colour terminal.
- Themes: exactly two - `dark` (default, assumes dark background) and `light`.
  Selected by `logging.theme` or `PLUGBOT_THEME`. A framework does not need a
  theme gallery; there will never be a third theme.

Token table (semantic token -> dark / light):

| Token | Dark | Light |
| --- | --- | --- |
| `fgMuted` (timestamps, keys) | bright-black (90) | bright-black (90) |
| `levelDebug` | bright-black (90) | green (32) |
| `levelInfo` | bright-cyan (96) | blue (34) |
| `levelWarn` | bright-yellow (93) | yellow-brown (33) |
| `levelError` | bright-red (91) | red (31) |
| `fgName` (logger names) | bright-blue (94) | magenta (35) |
| `fgPrompt` (REPL prompt) | bright-cyan (96) | blue (34) |
| `fgRef` (channel/user references) | bright-black (90) | bright-black (90) |

Approximate backgrounds used for contrast verification: dark `#1e1e1e`,
light `#fafafa`. All tokens verify at WCAG AA (>= 4.5:1) against their theme's
background using the standard xterm palette hex values.

## 5. CLI

One binary, `plugbot`. Help text is generated from the same command registry
structure as chat-side help; it can never drift from reality. No marketing
language, no emoji, no banners.

```
plugbot - build and run chat bots from plugins

Usage:
  plugbot <command> [options]

Commands:
  new      Create a plugin skeleton in a directory
  run      Run a bot from a configuration file
  dev      Run against the mock adapter with a REPL and hot reload
  doctor   Validate configuration and report what would load
  docs     Write a markdown reference for declared commands

Options:
  --config <path>   Configuration file (default: ./config.json, env PLUGBOT_CONFIG)
  --no-color        Disable coloured output
  --log-json        Emit logs as JSON lines
  --version         Print version
  -h, --help        Show help

Run "plugbot help <command>" for command details.
```

Per-command help follows a fixed section order: purpose sentence, Usage,
Arguments, Options, Examples. Examples are real invocations, runnable verbatim.

Exit codes: `0` success; `1` runtime failure; `2` configuration error.

## 6. Validation error anatomy

Startup collects every violation and reports all of them, worst first, then
exits 2. One violation renders as:

```
config error: adapter.type: expected one of "mock", "transcript", "irc", got "slack"
  at config.json:3  key "adapter.type"
```

Rules:

- First line: `config error: <dotted.key>: <expectation>, got <actual>`.
- Second line: source file and key path, always present.
- Unknown keys suggest the nearest known key when edit distance is <= 2:
  `unknown key "pluginz.dir" - did you mean "plugins.dir"?`
- Missing required keys: `missing required key "storage.file"`.
- Environment overrides report as `env PLUGBOT_ADAPTER__TYPE` in the same shape.
- Nothing else prints. No banner, no tips, no stack trace for config errors -
  a config error is data, not a crash.

## 7. Dev REPL specification

The REPL is a terminal UI, so it gets a real spec.

- Single monospace type scale (the terminal's own); vertical rhythm is one
  blank line between exchanges, none inside an exchange.
- Prompt: `you>` in `fgPrompt`, followed by the raw input echo-free (the
  terminal provides echo).
- Replies print one per line as: `[#channel] username: text` with channel and
  username in `fgRef`; reactions as `reacted :emoji:` in `fgRef`; edits show
  the new text prefixed `edited:`; deletions as `deleted`.
- Empty state (first paint): one line, e.g. `mock adapter ready. try !help`.
- Loading state: plain line `starting...` replaced by the ready line; no
  spinner, no animation.
- Error state: `error: <reason> - <next step>` in `levelError`, e.g.
  `error: config invalid - run "plugbot doctor" for details`.
- Keyboard: Enter submits; Ctrl+C clears the current input, and a second
  Ctrl+C within two seconds exits; Ctrl+D exits; ArrowUp/Down walk input
  history; Tab completes top-level command names.
- Themes: the two log themes apply unchanged via the same token table; no
  separate REPL palette exists.

## 8. Isolation model

Each plugin runs in its own worker thread by default (`isolation: "thread"`).
Declarations (commands, listeners, jobs, events metadata) cross to the host
once at load; handler bodies stay in the worker and execute over a
request/response bridge. Consequences, all deliberate:

- A handler that throws, rejects, or hangs past its timeout affects exactly
  its own worker. Timeout terminates the worker; it respawns on next use.
  In-memory plugin state dies with it; persistent state survives in storage.
- A synchronous infinite loop starves only its own worker and is killed at
  the timeout like any other hang. This is the only honest way to contain a
  CPU spin in JavaScript, so it is the documented behaviour, not a hidden one.
- `isolation: "inline"` runs handlers in-process. Timeouts still fire (via
  race) but a spinning loop cannot be preempted; inline mode is for embedding
  and debugging, and says so in its config comment. Inline plugins may also
  contribute host-side middleware; sandboxed ones may not, because functions
  cannot cross the worker boundary - declaring middleware in a sandboxed
  plugin is a load-time `PluginLoadError`, not a silent drop.

Breaker per plugin: opens after `limits.breakerThreshold` consecutive
handler failures within `breakerWindowMs`, stays open `breakerCooldownMs`,
then admits one probe request; success closes it, failure reopens. State
transitions log at warn with plugin name and counts.

## 9. Virtual clock

The scheduler, breaker timers, rate-limit windows, and handler timeouts all
read time from an injected `Clock`: `now(): number`, `setTimeoutFn`,
`clearTimeoutFn` equivalents. Production uses the real clock. The harness
installs a manual clock: `await clock.advanceMs(ms)` fires due timers in
order, synchronously, deterministically. Tests never sleep to make a job fire.

## 10. Storage format

One JSON file (default `data/storage.json`, gitignored):

```json
{ "version": 1, "plugins": { "poll": { "openPolls": [] } } }
```

A plugin's store handles are bound to its own namespace at construction; there
is no API that reaches across namespaces, so accidental cross-plugin reads
cannot be expressed. Writes debounce briefly and flush on graceful shutdown;
every write lands via temp-file-plus-rename so a crash never truncates the
store. On unparseable main file, the loader tries `storage.json.bak` and logs
an error either way.

## 11. Capability matrix

| Capability | mock | transcript | irc |
| --- | --- | --- | --- |
| send | yes | yes (recorded) | yes |
| edit | yes | no | no |
| delete | yes | no | no |
| react | yes | no | no |
| threads | yes | yes (flat replay) | no |
| typing | yes | no | no |
| memberEvents | yes | yes (from script) | yes |
| userLookup | yes | yes | partial (WHOIS) |
| channelLookup | yes | yes | yes |
| roles | yes | yes | yes (channel ops) |

Unsupported operations reject with `CapabilityError` naming the adapter and
operation. The matrix above is asserted by the shared conformance suite, so a
changed adapter updates the matrix or fails tests.

## 12. Testing stance

Every feature is demonstrated end to end through the mock adapter before it
counts as done. One conformance suite runs against every adapter. No test
contacts a live chat network: IRC tests speak to an in-process server on
localhost. Determinism beats realism everywhere the two conflict.
