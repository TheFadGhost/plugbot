import { describe, expect, it } from "vitest";
import { PermissionDeniedError } from "../src/errors.js";
import type { Authorizer } from "../src/permissions/types.js";
import type { CatalogCommand } from "../src/router/catalog.js";
import { catalogFromEntries } from "../src/router/catalog.js";
import type { CommandInput, DispatchResult, RouterDeps } from "../src/router/router.js";
import { createRouter } from "../src/router/router.js";
import type { Message, User } from "../src/types.js";

interface AuthCall {
  userId: string;
  permission?: string;
}

interface Harness {
  handleMessage(message: Message): Promise<DispatchResult>;
  replies: string[];
  runs: CommandInput[];
  authCalls: AuthCall[];
  store: CatalogCommand[];
}

function makeUser(id: string): User {
  return { id, username: id };
}

function makeMessage(text: string): Message {
  return {
    id: "m1",
    text,
    author: makeUser("alice"),
    channelId: "c1",
    createdAt: 0,
    mentions: [],
  };
}

const BASE_ENTRIES: CatalogCommand[] = [
  { plugin: "ping", path: ["ping"], description: "Reply with pong.", aliases: ["p"] },
  {
    plugin: "poll",
    path: ["poll", "create"],
    description: "Create a poll.",
    aliases: ["ask"],
    args: {
      title: { type: "string", required: true, description: "What to vote on" },
      duration: { type: "duration", default: "5m", description: "How long" },
    },
  },
  { plugin: "poll", path: ["poll", "create", "close"], description: "Close the poll early." },
  { plugin: "secret", path: ["poll", "create", "rig"], description: "Rig the poll.", hidden: true },
  { plugin: "moderation", path: ["ban"], description: "Ban a user.", permission: "admin" },
  { plugin: "secret", path: ["backdoor"], description: "Hidden thing.", hidden: true },
];

function makeHarness(options: { deny?: boolean; mentionAliases?: readonly string[]; prefix?: string } = {}): Harness {
  const store: CatalogCommand[] = [...BASE_ENTRIES];
  const replies: string[] = [];
  const runs: CommandInput[] = [];
  const authCalls: AuthCall[] = [];
  const authorizer: Authorizer = {
    async assertAllowed(user: User, permission?: string): Promise<void> {
      authCalls.push({ userId: user.id, permission });
      if (options.deny === true) throw new PermissionDeniedError(permission ?? "?", user.id);
    },
  };
  const deps: RouterDeps = {
    catalog: catalogFromEntries(store),
    replyTo: async (_message, text) => {
      replies.push(text);
      return null;
    },
    authorizer,
    invocation: {
      prefix: options.prefix ?? "!",
      mentionAliases: options.mentionAliases ?? [],
    },
  };
  const router = createRouter(deps, {
    runCommand: async (input) => {
      runs.push(input);
    },
  });
  return { handleMessage: router.handleMessage, replies, runs, authCalls, store };
}

describe("router dispatch", () => {
  it("ignores plain chat that is neither prefixed nor mentioned", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("hello world"));
    expect(result).toEqual({ status: "ignored" });
    expect(bot.replies).toHaveLength(0);
    expect(bot.runs).toHaveLength(0);
  });

  it("dispatches through the prefix with coerced args and applied defaults", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!poll create pizza 10s"));
    expect(result).toEqual({ status: "handled", commandPath: ["poll", "create"], plugin: "poll" });
    expect(bot.runs).toHaveLength(1);
    expect(bot.runs[0]!.args).toEqual({ title: "pizza", duration: 10_000 });
    expect(bot.runs[0]!.rawArgs).toEqual(["pizza", "10s"]);
    expect(bot.replies).toHaveLength(0);
  });

  it("applies declared defaults when an optional arg is absent", async () => {
    const bot = makeHarness();
    await bot.handleMessage(makeMessage("!poll create pizza"));
    expect(bot.runs[0]!.args).toEqual({ title: "pizza", duration: 300_000 });
  });

  it("resolves command aliases to the canonical declaration", async () => {
    const bot = makeHarness();
    const nested = await bot.handleMessage(makeMessage("!poll ask pizza"));
    expect(nested.status).toBe("handled");
    expect(nested.commandPath).toEqual(["poll", "create"]);
    expect(bot.runs[0]!.path).toEqual(["poll", "create"]);
    const topLevel = await bot.handleMessage(makeMessage("!p"));
    expect(topLevel.commandPath).toEqual(["ping"]);
  });

  it("strips mention aliases case-insensitively, longest first", async () => {
    const bot = makeHarness({ mentionAliases: ["@plug", "@plug bot"] });
    const result = await bot.handleMessage(makeMessage("@PLUG BOT ping"));
    expect(result.status).toBe("handled");
    expect(result.commandPath).toEqual(["ping"]);
  });

  it("answers a bare prefix with the overview help", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!"));
    expect(result.status).toBe("handled");
    expect(result.commandPath).toEqual(["help"]);
    expect(bot.runs).toHaveLength(0);
    const reply = bot.replies[0]!;
    expect(reply.split("\n")[0]).toBe("Commands:");
    expect(reply).toContain("Reply with pong.");
    expect(reply.endsWith('Run "!help <command>" for details.')).toBe(true);
  });

  it("dispatches deep subcommand chains with the exact path", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!poll create close"));
    expect(result).toEqual({ status: "handled", commandPath: ["poll", "create", "close"], plugin: "poll" });
    expect(bot.runs[0]!.path).toEqual(["poll", "create", "close"]);
    expect(bot.runs[0]!.args).toEqual({});
    expect(bot.runs[0]!.rawArgs).toEqual([]);
  });

  it("replies for unknown commands and does not run anything", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!frobnicate now"));
    expect(result.status).toBe("unknown-command");
    expect(result.commandPath).toBeUndefined();
    expect(bot.replies).toEqual(['unknown command "frobnicate" - try "!help"']);
    expect(bot.runs).toHaveLength(0);
  });

  it("names the parent for unknown subcommands and keeps the parent path", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!poll frobnicate"));
    expect(result.status).toBe("unknown-command");
    expect(result.commandPath).toEqual(["poll"]);
    expect(bot.replies).toEqual(['unknown subcommand "frobnicate" for "poll" - try "!help poll"']);
    expect(bot.runs).toHaveLength(0);
  });
});

describe("router help", () => {
  it("lists declared descriptions verbatim in the overview", async () => {
    const bot = makeHarness();
    await bot.handleMessage(makeMessage("!help"));
    const reply = bot.replies[0]!;
    expect(reply).toContain("Reply with pong.");
    expect(reply).toContain("Create a poll.");
    expect(reply).toContain("Close the poll early.");
    expect(reply).toContain("Ban a user.");
  });

  it("shows the usage line on drill-down", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!help poll create"));
    expect(result.status).toBe("handled");
    expect(result.commandPath).toEqual(["help"]);
    const reply = bot.replies[0]!;
    expect(reply.split("\n")[0]).toBe("poll create - Create a poll.");
    expect(reply).toContain("Usage: !poll create <title> [duration]");
    expect(reply).toContain("What to vote on");
    expect(reply).toContain("Aliases: ask");
  });

  it("excludes hidden commands everywhere", async () => {
    const bot = makeHarness();
    await bot.handleMessage(makeMessage("!help"));
    const overview = bot.replies[0]!;
    expect(overview).not.toContain("backdoor");
    expect(overview).not.toContain("Rig the poll.");
    await bot.handleMessage(makeMessage("!help backdoor"));
    expect(bot.replies[1]).toBe('no help for "backdoor"');
    await bot.handleMessage(makeMessage("!help poll create"));
    expect(bot.replies[2]).not.toContain("rig");
  });
});

describe("router permissions", () => {
  it("replies generically on denial without leaking roles", async () => {
    const bot = makeHarness({ deny: true });
    const result = await bot.handleMessage(makeMessage("!ban u9"));
    expect(result.status).toBe("denied");
    expect(result.commandPath).toEqual(["ban"]);
    expect(result.plugin).toBe("moderation");
    expect(bot.replies).toEqual(["you don't have permission to run that command"]);
    expect(bot.replies[0]!.includes("admin")).toBe(false);
    expect(bot.runs).toHaveLength(0);
  });

  it("records the authorizer call but never consults it for public commands", async () => {
    const allowed = makeHarness();
    await allowed.handleMessage(makeMessage("!ban u9"));
    expect(allowed.authCalls).toEqual([{ userId: "alice", permission: "admin" }]);
    const publicBot = makeHarness();
    await publicBot.handleMessage(makeMessage("!ping"));
    expect(publicBot.authCalls).toEqual([]);
  });
});

describe("router argument failures", () => {
  it("replies multi-line with usage, problems, and argument docs", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!poll create"));
    expect(result.status).toBe("invalid-args");
    expect(result.commandPath).toEqual(["poll", "create"]);
    const lines = bot.replies[0]!.split("\n");
    expect(lines[0]).toBe("usage: !poll create <title> [duration]");
    expect(lines).toContain("problem: missing required argument title");
    expect(lines).toContain("Arguments:");
    expect(lines).toContain("  title (string, required) What to vote on");
    expect(lines).toContain("  duration (duration, default \"5m\") How long");
  });

  it("names unexpected extras against a schema-less command", async () => {
    const bot = makeHarness();
    const result = await bot.handleMessage(makeMessage("!ping boom"));
    expect(result.status).toBe("invalid-args");
    const lines = bot.replies[0]!.split("\n");
    expect(lines[0]).toBe("usage: !ping");
    expect(lines).toContain('problem: unexpected argument "boom"');
  });
});

describe("router handler isolation boundary", () => {
  it("propagates handler exceptions unchanged", async () => {
    const sentinel = new Error("boom");
    const store: CatalogCommand[] = [{ plugin: "ping", path: ["ping"], description: "Reply with pong." }];
    const replies: string[] = [];
    const deps: RouterDeps = {
      catalog: catalogFromEntries(store),
      replyTo: async (_message, text) => {
        replies.push(text);
        return null;
      },
      authorizer: {
        async assertAllowed(): Promise<void> {},
      },
      invocation: { prefix: "!", mentionAliases: [] },
    };
    const router = createRouter(deps, {
      runCommand: async () => {
        throw sentinel;
      },
    });
    await expect(router.handleMessage(makeMessage("!ping"))).rejects.toBe(sentinel);
    expect(replies).toHaveLength(0);
  });
});

describe("router fresh catalog per message", () => {
  it("routes commands added after construction immediately", async () => {
    const bot = makeHarness();
    const before = await bot.handleMessage(makeMessage("!stats"));
    expect(before.status).toBe("unknown-command");
    bot.store.push({ plugin: "metrics", path: ["stats"], description: "Show stats." });
    const after = await bot.handleMessage(makeMessage("!stats"));
    expect(after.status).toBe("handled");
    expect(after.commandPath).toEqual(["stats"]);
    expect(after.plugin).toBe("metrics");
    expect(bot.runs[0]!.plugin).toBe("metrics");
  });
});
