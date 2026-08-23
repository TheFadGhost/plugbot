import type { PluginSpec } from "../plugin/types.js";

const spec: PluginSpec = {
  name: "ping",
  description: "Minimal example plugin.",

  commands: {
    ping: {
      description: "Reply with pong.",
      async run(ctx) {
        await ctx.reply("pong");
      },
    },
  },
};

export default spec;
