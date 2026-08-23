import type { CommandDef, PluginSpec, PluginStore } from "../plugin/types.js";

interface PollRecord {
  id: string;
  question: string;
  options: string[];
  votes: Record<string, number>;
  channelId: string;
  status: "open" | "closed";
}

interface OpenEntry {
  id: string;
  channelId: string;
}

function isOpenEntry(value: unknown): value is OpenEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.channelId === "string";
}

async function openIndex(store: PluginStore): Promise<OpenEntry[]> {
  const index = await store.get<OpenEntry[]>("openPolls");
  return (index ?? []).filter(isOpenEntry);
}

async function saveIndex(store: PluginStore, entries: OpenEntry[]): Promise<void> {
  await store.set("openPolls", entries);
}

async function latestOpenIn(store: PluginStore, channelId: string): Promise<PollRecord | undefined> {
  const index = [...await openIndex(store)].reverse();
  for (const entry of index) {
    if (entry.channelId !== channelId) continue;
    const poll = await store.get<PollRecord>(`poll:${entry.id}`);
    if (poll && poll.status === "open") return poll;
  }
  return undefined;
}

function tally(poll: PollRecord): number[] {
  const counts = new Array<number>(poll.options.length).fill(0);
  for (const choice of Object.values(poll.votes)) {
    if (Number.isInteger(choice) && choice >= 1 && choice <= counts.length) {
      counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
    }
  }
  return counts;
}

function renderTallies(poll: PollRecord): string {
  const counts = tally(poll);
  const lines = [`poll ${poll.id}: ${poll.question}`];
  poll.options.forEach((option, position) => {
    const count = counts[position] ?? 0;
    const bar = "*".repeat(Math.min(count, 10));
    lines.push(`${option} **${count}** ${bar}`.trimEnd());
  });
  return lines.join("\n");
}

const startArgs = {
  question: { type: "string", required: true, description: "Poll question." },
  options: { type: "string", rest: true, required: true, description: "Answer options." },
} as const;

const startCommand: CommandDef<typeof startArgs> = {
  description: "Start a poll.",
  args: startArgs,
  async run(ctx) {
    if (ctx.args.options.length < 2) {
      await ctx.reply("need at least two options");
      return;
    }
    const seq = ((await ctx.store.get<number>("seq")) ?? 0) + 1;
    const poll: PollRecord = {
      id: `p${seq}`,
      question: ctx.args.question,
      options: [...ctx.args.options],
      votes: {},
      channelId: ctx.message.channelId,
      status: "open",
    };
    await ctx.store.set("seq", seq);
    await ctx.store.set(`poll:${poll.id}`, poll);
    const index = await openIndex(ctx.store);
    index.push({ id: poll.id, channelId: poll.channelId });
    await saveIndex(ctx.store, index);
    const lines = [`poll ${poll.id}: ${poll.question}`];
    poll.options.forEach((option, position) => {
      lines.push(`${position + 1}. ${option}`);
    });
    await ctx.reply(lines.join("\n"));
  },
};

const voteArgs = {
  choice: { type: "number", required: true, description: "Option number." },
} as const;

const voteCommand: CommandDef<typeof voteArgs> = {
  description: "Vote on the latest open poll here.",
  aliases: ["v"],
  args: voteArgs,
  async run(ctx) {
    const poll = await latestOpenIn(ctx.store, ctx.message.channelId);
    if (!poll) {
      await ctx.reply("no open poll here");
      return;
    }
    const choice = ctx.args.choice;
    if (!Number.isInteger(choice) || choice < 1 || choice > poll.options.length) {
      await ctx.reply(`pick an option between 1 and ${poll.options.length}`);
      return;
    }
    poll.votes[ctx.message.author.id] = choice;
    await ctx.store.set(`poll:${poll.id}`, poll);
    if (ctx.capabilities.react) {
      await ctx.react("+1");
      return;
    }
    await ctx.reply(`vote recorded: ${poll.options[choice - 1] ?? "unknown option"}`);
  },
};

const statusArgs = {
  id: { type: "string", required: false, default: "", description: "Poll id; latest open poll when omitted." },
} as const;

const statusCommand: CommandDef<typeof statusArgs> = {
  description: "Show tallies for a poll.",
  args: statusArgs,
  async run(ctx) {
    const poll =
      ctx.args.id !== ""
        ? await ctx.store.get<PollRecord>(`poll:${ctx.args.id}`)
        : await latestOpenIn(ctx.store, ctx.message.channelId);
    if (!poll) {
      await ctx.reply("no poll to show");
      return;
    }
    await ctx.reply(renderTallies(poll));
  },
};

const closeArgs = {
  id: { type: "string", required: false, default: "", description: "Poll id; latest open poll when omitted." },
} as const;

const closeCommand: CommandDef<typeof closeArgs> = {
  description: "Close a poll and declare a winner.",
  args: closeArgs,
  async run(ctx) {
    const poll =
      ctx.args.id !== ""
        ? await ctx.store.get<PollRecord>(`poll:${ctx.args.id}`)
        : await latestOpenIn(ctx.store, ctx.message.channelId);
    if (!poll) {
      await ctx.reply("no poll to close");
      return;
    }
    poll.status = "closed";
    await ctx.store.set(`poll:${poll.id}`, poll);
    const remaining = (await openIndex(ctx.store)).filter((entry) => entry.id !== poll.id);
    await saveIndex(ctx.store, remaining);
    const counts = tally(poll);
    let best = 0;
    counts.forEach((count) => {
      best = Math.max(best, count);
    });
    const winners = poll.options.filter((_option, position) => (counts[position] ?? 0) === best);
    const summary =
      winners.length > 1
        ? `tie between ${winners.join(", ")}`
        : `winner: ${winners[0] ?? "nobody"} (${best} vote${best === 1 ? "" : "s"})`;
    await ctx.reply(`closed ${poll.id} - ${summary}`);
  },
};

const pollCommand: CommandDef = {
  description: "Run channel polls.",
  subcommands: {
    start: startCommand,
    vote: voteCommand,
    status: statusCommand,
    close: closeCommand,
  },
};

const spec: PluginSpec = {
  name: "poll",
  description: "Channel polls with open votes and tallies.",

  commands: {
    poll: pollCommand,
  },
};

export default spec;
