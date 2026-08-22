# PLAN.md

Feature ideation for Plugbot. Each candidate was judged against three tests:

1. Does it serve the core purpose of making bot logic portable and testable?
2. Can it be finished to the same quality bar?
3. Does it avoid expanding scope into a second product?

## Accepted

| Feature | Reason |
| --- | --- |
| Scaffold command (`plugbot new`) | Thin template over the existing plugin API; huge onboarding payoff, nothing new to design. |
| Zero-config boot | Empty config starts mock adapter with safe defaults; makes "build without touching a real service" real in five minutes. |
| Error attribution | Failures name plugin and handler with stacks through user code only; isolation is undebuggable without it. |
| Structured logging with levels | Completes the logging middleware; JSON capture strengthens the test harness. |
| Dev REPL | Shortest edit-run-inspect loop against the exact adapters built for development. |
| Graceful shutdown draining | Correct lifecycle is part of portability; production adapters kill processes without warning. |
| Generated docs from declarations | Pure reuse of router metadata that powers generated help; near-zero marginal design cost. |
| TypeScript definitions for the plugin API | Typed commands are what make plugin logic behave identically across platforms. |
| Adapter conformance suite | Pluggable adapters are only true if interchangeability is enforced by running tests, not inspection. |
| Virtual clock | Scheduled jobs are untestable deterministically without controllable time; harness incomplete until time is fake. |
| Storage interface + one file-backed KV | Same plugin moves from test state to persistent state unchanged; explicitly refuse many backends. |
| Unified CLI (`new` / `run` / `dev` / `doctor` / `docs`) | Shell around three decided capabilities, not a fourth subsystem. |
| Metrics as in-process counters | Middleware already collects them; exposed via `bot.metrics()` and the test harness instead of a network endpoint. |

## Rejected

| Feature | Reason |
| --- | --- |
| Metrics/health HTTP endpoint | Serves existing counters but drags in server lifecycle and port management; counters via API cover the need (test 3). |
| Rich-text normalization layer | A markup vocabulary plus per-platform renderers is its own subsystem; plain text keeps plugin output identical everywhere (test 2). |
| Conversation-flow primitives (await-next-reply, wizards) | Beachhead of a dialogue engine; multi-turn state machines balloon immediately (test 3). |
| Plugin registry/marketplace | Distribution and discovery are a second product with trust, versioning, hosting obligations (test 3). |
| Web admin dashboard | Accounts, auth, sessions, frontend; contributes nothing to portable testable logic (tests 1 and 3). |
| Hosted bot platform | Textbook second product; enters disguised as "one-command deploy" (test 3). |
| NLU/intent engine | Exact-match commands with schemas is the chosen scope; intent classification has different failure modes entirely (test 3). |
| i18n/localization layer | Locale negotiation, pluralization, translation pipelines form their own product surface serving neither portability nor testability (tests 2 and 3). |

## Highest value if nothing else shipped

1. Zero-config boot with the mock adapter - the first five minutes decide adoption.
2. Virtual clock - without it, scheduled jobs are dead weight in the test story.
3. Error attribution to plugin and handler - isolation without diagnosis is indistinguishable from breakage.

## Most dangerous scope traps

1. Hosted platform, entering via "one-command deploy to our cloud".
2. Web dashboard, entering via "remote config editing would be handy".
3. NLU engine, entering via typo-tolerant matching and conversation-flow helpers.
