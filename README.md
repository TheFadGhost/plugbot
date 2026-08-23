# Plugbot

A chat-bot framework where behaviour lives in plugins and chat platforms are pluggable adapters - built for developers who want bot logic that is testable and portable, developed entirely against mock adapters without touching a real chat service.

## Install

Requires Node 20.10 or newer.

```sh
git clone https://github.com/TheFadGhost/plugbot
cd plugbot
npm install
npm run build
```

## A complete minimal plugin

This is a whole plugin. No registration call, no manifest, no config entry - drop it in your plugins directory and it loads.

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

Commands are invoked with the configured prefix (`!ping`) or a mention alias (`plugbot: ping`). Arguments are declared as schemas and coerced before your handler runs; help text is generated from those declarations and can never drift from reality.

## Run it

```sh
plugbot doctor                # validate config, list what would load
plugbot dev                   # mock adapter + REPL + hot reload
plugbot run --config prod.json
plugbot new my-plugin         # scaffold a skeleton
plugbot docs                  # markdown reference from declarations
```

`plugbot dev` against the bundled examples looks like this (see `docs/terminal-session.txt` for the raw capture):

```text
mock adapter ready. try !help

you> !help
[#general] plugbot: Commands:
  mystats - Report dispatch counters.
  note - Moderation notes.
    note add - Add a note about a user.
    ...
  ping - Reply with pong.
  poll - Run channel polls.
Run "!help <command>" for details.

you> !remind 1h tea
[#general] plugbot: reminder r1 set for 1h from now

you> !poll start "lunch?" ramen salad
[#general] plugbot: poll p1: lunch?
1. ramen
2. salad

you> !mystats
[#general] plugbot: seen 4 messages, avg dispatch 4.8ms (last 1.0)
```

## Test a plugin

The test harness spins up the real bot on the mock adapter, feeds it messages, and hands you what came back:

```ts
import { TestBot } from "plugbot/testing";

const bot = await TestBot.create({
  pluginSources: { "echo.ts": sourceString },
});
const page = await bot.receive({ from: "alice", text: "!echo hello" });
expect(page.texts()[0]?.text).toBe("hello");
await bot.stop();
```

Scheduled jobs advance deterministically - `await bot.advanceMs(16_000)` fires timers in order instead of sleeping. Helpers cover reactions, edits, deletions, and thread-scoped sends. Adapter authors run the shared conformance suite:

```ts
import { describeAdapterConformance } from "plugbot/testing";

await describeAdapterConformance("my-adapter", () => new MyAdapter());
```

## Adapters

Every adapter implements one interface and declares its capabilities; unsupported operations reject loudly instead of silently doing nothing.

| Capability | mock | transcript | irc |
| --- | --- | --- | --- |
| send | yes | yes (recorded) | yes |
| edit | yes | no | no |
| delete | yes | no | no |
| react | yes | no | no |
| threads | yes | yes (flat replay) | no |
| typing | yes | no | no |
| memberEvents | yes | yes (from script) | yes |
| userLookup | yes | yes | no |
| channelLookup | yes | yes | yes |
| roles | yes | yes | yes (channel ops) |

- **mock** - fully featured in-memory platform with `simulateMessage`, `simulateJoin`, and a queryable delivery log. The whole bot runs here.
- **transcript** - replays a scripted conversation file deterministically and records outbound messages; same input, identical output, every time.
- **irc** - speaks RFC 1459 over TCP with token-bucket outbound rate limiting, exponential reconnect backoff with jitter, keepalive, and NAMES-based role resolution. Tests drive it against an in-process localhost server, never a live network.

### Writing an adapter

Extend `BaseAdapter`, set `capabilities` honestly, override what you support - the base class rejects everything else with a `CapabilityError`. Then prove it:

```ts
await describeAdapterConformance("mine", () => new MyAdapter(config));
```

The conformance suite checks send contracts, lookup shapes, capability truthfulness (the matrix above is asserted, not decorative), id determinism, and lifecycle behaviour.

## Architecture

Three layers, one direction of dependency:

```
plugins/          declare commands, listeners, jobs, events
   │
runtime/          isolation (worker thread per plugin), router,
   │              middleware pipeline, scheduler, breaker, storage
   │
adapters/         mock · transcript · irc  ← one interface each
```

Plugins never touch platforms; adapters never contain bot logic. Each plugin executes in its own worker thread by default, so a handler that throws, hangs past its timeout, or spins the CPU is terminated without touching any other plugin; the circuit breaker disables a repeatedly failing plugin with a logged reason and re-probes after a cooldown. An inline mode exists for embedding and for plugins that contribute host-side middleware.

## Bundled example plugins

| Plugin | Demonstrates |
| --- | --- |
| `ping` | the minimal shape |
| `reminders` | typed duration args, scheduled jobs, persistent storage |
| `poll` | subcommands, aliases, per-channel state, reactions |
| `modnotes` | admin permissions via adapter roles, join events, user lookup |
| `gatekeeper` | inline isolation contributing host-side middleware |

Run them all against the mock adapter: `npm run examples`.

## Configuration

Sensible defaults mean an empty config boots the mock adapter. Copy `config.example.json` to `config.json` and change what you need; environment overrides use the `PLUGBOT_` prefix (`PLUGBOT_LOGGING__LEVEL=debug`). Validation errors name the exact offending key and suggest near misses. Storage files and real credentials belong in gitignored paths - `config.json` is already ignored, `config.example.json` carries placeholders only.

## License

MIT
