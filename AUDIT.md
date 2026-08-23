# AUDIT.md

Pre-release audit for v1.0.0. Three independent audits ran against the
shipped tree, each performed by an agent that had not written the code under
review. Every finding was either fixed or explicitly dispositioned; the full
suite (273 tests) and the examples regression script were re-run green after
each fix round, and the built `dist/` output was probed directly.

## Round 1 - API ergonomics (fresh agent authoring a plugin from docs only)

Findings and dispositions:

1. Duration units, positional argument rules, cooldown scope, and dailyAt
   timezone were undocumented - three semantic guesses per nontrivial plugin.
   FIXED: documented precisely in DESIGN.md section 1 (duration parses
   `<n><ms|s|m|h|d>` to milliseconds; arguments are positional in schema
   declaration order, no flags; cooldowns are per plugin+listener+channel;
   dailyAt is host-local time).
2. `configSchema` validated but never typed `ctx.config`; DESIGN's own complex
   example would not compile against shipped types. FIXED: `definePlugin` is
   generic over `configSchema`; `init` receives fully typed config
   (`ParsedPluginConfig<S>`); every context now exposes validated
   `ctx.config`; README documents the init-stash pattern for handlers.
3. Bundled plugins cannot import `"plugbot"` (worker threads), while README's
   flagship snippet uses that import. DISPOSITIONED: both are true for their
   audiences - repo-internal examples use type-only imports (documented in
   DESIGN section 1); installed-package users import normally (README now
   says so explicitly).
4. `plugbot` not on PATH after clone-install; README commands unfollowable.
   FIXED: install section gained `npm link`, plus the `npx tsx src/cli/main.ts`
   equivalent for in-repo use.
5. `plugbot/testing` subpath, harness API surface, and vitest imports
   undocumented in README. FIXED: testing snippet now shows explicit imports;
   TestBot surface listed method by method.
6. Capability matrix drift: README said irc userLookup yes, DESIGN said
   partial. FIXED: both now say no (WHOIS out of scope v1); conformance suite
   asserts the matrix.

## Round 2 - Code integrity (fresh agent, adversarial trace)

Blocker:

- Compiled build could never spawn thread-isolated plugins: worker entry URL
  hardcoded `.ts`. FIXED: extension-aware URL (`import.meta.filename`);
  verified end to end from `dist/cli/main.js` with a real plugin answering a
  command through the mock adapter.

Majors:

- Command trie construction existed three times (router, help, docs) and the
  docs copy had already drifted (missing group-command metadata). FIXED:
  single shared `buildCommandTrie` in router/catalog.ts consumed by all
  three; runnable flag flows everywhere.
- Two diverging logger implementations (child separator `:` vs `.`).
  FIXED: default logger joins dotted paths like the rich one.
- Typing handles leaked on worker death/timeout/dispose. FIXED: all live
  typing indicators stopped and cleared on every teardown path.
- Hot reload activated disabled plugins. FIXED: reload path consults the
  disabled list and tears down instead.
- Reload adopt-failure leaked the freshly spawned worker. FIXED: adopt is
  guarded; failed adoptions dispose their runtime.
- Transcript adapter corrupted its own record format on multi-line replies
  (help text contains newlines). FIXED: recorded lines sanitize line breaks,
  matching the IRC adapter's behaviour.
- Metrics double-counted failures (middleware and dispatch layer both
  recorded) and counted rate-limited messages as failed commands. FIXED:
  single recording site at the dispatch layer; middleware counts messages
  only; unknown/invalid/denied outcomes count once as failed.
- PLUGIN_* stack contract unmet in both directions (full framework stack
  retained but nothing ever rendered). FIXED: warn lines stay clean;
  HandlerError cause stack renders at debug level only, per DESIGN.

Minors fixed in the same round: PLUGBOT_CONFIG env var actually read (was
advertised but ignored); env-sourced violations render `at env VARNAME`;
unreadable storage file no longer misdiagnosed as absent; unreadable plugin
dirs log warnings in doctor and reload; watcher failures surface via logged
callback; dead exports removed (`CommandUnknownError`,
`ArgumentValidationError`, `SentMessage` alias, `pluginConfigFailure`, dead
nested-RPC fields); `configPath` wired into the ready log it promised;
handler-failure metric map capped; IRC outbound validates positive rate-limit
options, budgets the PRIVMSG target overhead against line length, strips NUL
bytes, and captures async write errors; mock adapter honours
`bot.username` config; help texts moved value flags into Options sections;
DESIGN section 4 self-contradiction on dim timestamps resolved in favour of
the implementation; DESIGN section 2 documents the noun-read-accessor
exception; DESIGN section 6 examples replaced with the exact shipped output.

Dispositioned without change (with reasons):

- Socket `'error'` handler empty in IRC adapter: TCP close always follows and
  owns reconnection; write errors are now captured for attribution.
- Inline-mode shutdown reasons collapse to `drained:false`: counter semantics
  documented; plugin-side detail stays inside the plugin.
- ESM module accumulation across inline hot reloads: bounded by dev-session
  lifetime; thread mode (default) has no such cache.

## Round 3 - Design/output conformance (fresh agent, execution-based)

Human and JSON logging modes, colour governance (NO_COLOR, --no-color,
non-TTY auto-off, forced colour, theme differentiation, 16-colour safety),
CLI help layout and root-text verbatim match, validation-error anatomy,
REPL interaction spec, two-theme token table, exit codes 0/1/2: all PASS by
execution. The deviations found (items 12-14 above) were doc/code mismatches
resolved in this round; banned-content sweep over help texts, README, and
bundled plugins found zero emoji, banners, or marketing language.

## Final gate

- `npm run typecheck` clean (strict, noUncheckedIndexedAccess).
- `npm test`: 273 passed, 0 failed, three consecutive runs including a
  loaded-machine run (flake fixed structurally via harness quiet-detection,
  no assertions weakened).
- `npm run examples`: all five bundled plugins pass through the real bot on
  the mock adapter.
- `npm run build` + dist probes: package entry, testing subpath import
  cleanly without vitest loaded; CLI runs from dist; thread-isolated plugin
  answers a command from dist.
- No test contacts a live chat network; IRC traffic stays on localhost.
