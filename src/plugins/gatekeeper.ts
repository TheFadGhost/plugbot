import type { Middleware, PluginSpec } from "../plugin/types.js";

let seenMessages = 0;
let lastMs = 0;
const recentMs: number[] = [];

const dispatchTimer: Middleware = async (_message, next) => {
  const startedAt = Date.now();
  await next();
  const elapsedMs = Date.now() - startedAt;
  seenMessages += 1;
  lastMs = elapsedMs;
  recentMs.push(elapsedMs);
  if (recentMs.length > 50) recentMs.shift();
};

const spec: PluginSpec = {
  name: "gatekeeper",
  isolation: "inline",
  description:
    "Counts dispatched messages and reports pipeline timing." +
    " Counters live in memory and reset on reload." +
    " Inline mode is required because middleware must run host-side.",

  middleware: [dispatchTimer],

  commands: {
    mystats: {
      description: "Report dispatch counters.",
      async run(ctx) {
        const sum = recentMs.reduce((total, ms) => total + ms, 0);
        const averageMs = recentMs.length === 0 ? 0 : sum / recentMs.length;
        await ctx.reply(
          `seen ${seenMessages} messages, avg dispatch ${averageMs.toFixed(1)}ms (last ${lastMs.toFixed(1)})`,
        );
      },
    },
  },
};

export default spec;
