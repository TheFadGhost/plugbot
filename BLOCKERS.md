# BLOCKERS.md

No open blockers. This file records the state of any work that had to stop
for lack of a path forward; it is empty at the v1.0.0 audit.

Historical notes for future readers:

- Worker threads and native TypeScript: thread-isolated plugins rely on
  Node's type stripping for `.ts` plugin files (Node >= 23.6). If support is
  ever needed for older runtimes, the worker bootstrap needs a loader hook
  (for example `--import tsx`); the extension-aware entry URL in
  workerBridge.ts already handles compiled `.js` output.
- Inline isolation cannot preempt a synchronous infinite loop (documented in
  DESIGN section 8); containing one requires the default thread mode. No
  in-process workaround exists in JavaScript; revisit only if an embedding
  use case demands inline mode with hard CPU containment.
- `plugbot docs` loads plugins with a rejecting outbound stub, so a plugin
  whose `init` sends messages reports that plugin as failed during doc
  generation. A dedicated declaration-only load mode would remove the caveat.
