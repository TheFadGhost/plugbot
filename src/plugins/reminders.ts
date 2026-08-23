import type { CommandDef, PluginSpec, PluginStore } from "../plugin/types.js";

interface Reminder {
  id: string;
  channelId: string;
  dueAt: number;
  text: string;
  requester: string;
}

function formatSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds >= 86400) return `${Math.round(totalSeconds / 86400)}d`;
  if (totalSeconds >= 3600) return `${Math.round(totalSeconds / 3600)}h`;
  if (totalSeconds >= 60) return `${Math.round(totalSeconds / 60)}m`;
  return `${totalSeconds}s`;
}

function isReminder(value: unknown): value is Reminder {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.channelId === "string" &&
    typeof candidate.dueAt === "number" &&
    typeof candidate.text === "string" &&
    typeof candidate.requester === "string"
  );
}

async function readReminders(store: PluginStore): Promise<Reminder[]> {
  const pending: Reminder[] = [];
  for (const [, value] of await store.list("r")) {
    if (isReminder(value)) pending.push(value);
  }
  return pending.sort((a, b) => a.dueAt - b.dueAt);
}

const remindArgs = {
  duration: { type: "duration", required: true, description: "Time from now, e.g. 90s, 5m, 2h." },
  text: { type: "string", rest: true, required: true, description: "What to remind about." },
} as const;

const remindCommand: CommandDef<typeof remindArgs> = {
  description: "Set a reminder.",
  args: remindArgs,
  async run(ctx) {
    const seq = ((await ctx.store.get<number>("seq")) ?? 0) + 1;
    const reminder: Reminder = {
      id: `r${seq}`,
      channelId: ctx.message.channelId,
      dueAt: ctx.clock.now() + ctx.args.duration,
      text: ctx.args.text.join(" "),
      requester: ctx.message.author.username,
    };
    await ctx.store.set("seq", seq);
    await ctx.store.set(reminder.id, reminder);
    await ctx.reply(`reminder ${reminder.id} set for ${formatSpan(ctx.args.duration)} from now`);
  },
};

const forgetArgs = {
  id: { type: "string", required: true, description: "Reminder id, e.g. r3." },
} as const;

const forgetCommand: CommandDef<typeof forgetArgs> = {
  description: "Remove a pending reminder.",
  args: forgetArgs,
  async run(ctx) {
    const removed = await ctx.store.delete(ctx.args.id);
    await ctx.reply(removed ? `removed ${ctx.args.id}` : `no reminder ${ctx.args.id}`);
  },
};

const listCommand: CommandDef = {
  description: "List pending reminders.",
  async run(ctx) {
    const now = ctx.clock.now();
    const pending = (await readReminders(ctx.store)).filter((item) => item.dueAt > now);
    if (pending.length === 0) {
      await ctx.reply("no reminders");
      return;
    }
    const lines = pending.map((item) => `${item.id} in ${formatSpan(item.dueAt - now)}: ${item.text}`);
    await ctx.reply(lines.join("\n"));
  },
};

const spec: PluginSpec = {
  name: "reminders",
  description: "Persistent reminder scheduler.",

  commands: {
    remind: remindCommand,
    forget: forgetCommand,
    reminders: listCommand,
  },

  jobs: [
    {
      name: "sweep",
      schedule: { everyMs: 15000 },
      description: "Deliver due reminders.",
      async run(ctx) {
        const now = ctx.clock.now();
        for (const item of await readReminders(ctx.store)) {
          if (item.dueAt > now || !ctx.capabilities.send) continue;
          await ctx.bot.send(item.channelId, `${item.text} - reminder set by ${item.requester}`);
          await ctx.store.delete(item.id);
        }
      },
    },
  ],
};

export default spec;
