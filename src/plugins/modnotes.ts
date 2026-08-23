import type { CommandDef, OutboundApi, PluginSpec, PluginStore } from "../plugin/types.js";

interface NoteEntry {
  by: string;
  at: number;
  text: string;
}

function isNoteArray(value: unknown): value is NoteEntry[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.by === "string" &&
      typeof candidate.at === "number" &&
      typeof candidate.text === "string"
    );
  });
}

async function readNotes(store: PluginStore, uid: string): Promise<NoteEntry[]> {
  const notes = await store.get<NoteEntry[]>(`notes:${uid}`);
  return isNoteArray(notes) ? notes : [];
}

async function resolveUid(bot: OutboundApi, raw: string): Promise<string> {
  const user = await bot.getUser(raw);
  return user ? user.id : raw;
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

const addArgs = {
  user: { type: "string", required: true, description: "User to note." },
  text: { type: "string", rest: true, required: true, description: "Note text." },
} as const;

const addCommand: CommandDef<typeof addArgs> = {
  description: "Add a note about a user.",
  permission: "admin",
  args: addArgs,
  async run(ctx) {
    const uid = await resolveUid(ctx.bot, ctx.args.user);
    const entry: NoteEntry = {
      by: ctx.message.author.username,
      at: ctx.clock.now(),
      text: ctx.args.text.join(" "),
    };
    const notes = await readNotes(ctx.store, uid);
    notes.push(entry);
    await ctx.store.set(`notes:${uid}`, notes);
    await ctx.reply(`noted ${uid}: ${entry.text}`);
  },
};

const showArgs = {
  user: { type: "string", required: true, description: "User to look up." },
} as const;

const showCommand: CommandDef<typeof showArgs> = {
  description: "Show notes for a user.",
  args: showArgs,
  async run(ctx) {
    const uid = await resolveUid(ctx.bot, ctx.args.user);
    const notes = await readNotes(ctx.store, uid);
    if (notes.length === 0) {
      await ctx.reply(`no notes for ${uid}`);
      return;
    }
    const lines = notes.map((note) => `${isoDay(note.at)} ${note.by}: ${note.text}`);
    await ctx.reply(lines.join("\n"));
  },
};

const countCommand: CommandDef = {
  description: "Count notes across all users.",
  async run(ctx) {
    const entries = await ctx.store.list("notes:");
    let total = 0;
    for (const [, value] of entries) {
      if (isNoteArray(value)) total += value.length;
    }
    await ctx.reply(`${total} notes on ${entries.length} users`);
  },
};

const noteCommand: CommandDef = {
  description: "Moderation notes.",
  subcommands: {
    add: addCommand,
    show: showCommand,
    count: countCommand,
  },
};

const spec: PluginSpec = {
  name: "modnotes",
  description: "Moderation notes with admin-gated writes.",

  commands: {
    note: noteCommand,
  },

  events: {
    memberJoin: async (ctx) => {
      if (!ctx.capabilities.send) return;
      let uid = ctx.event.userId;
      let notes = await readNotes(ctx.store, uid);
      if (notes.length === 0) {
        const user = await ctx.bot.getUser(uid);
        if (user) {
          uid = user.username;
          notes = await readNotes(ctx.store, uid);
        }
      }
      if (notes.length === 0) return;
      await ctx.bot.send(ctx.event.channelId, `welcome back ${ctx.event.userId} (${notes.length} prior notes)`);
    },
  },
};

export default spec;
