import { PermissionDeniedError } from "../errors.js";
import type { Authorizer } from "../permissions/types.js";
import type { Logger } from "../logging/types.js";
import type { Message } from "../types.js";
import { parseArguments } from "./argsParser.js";
import { buildCommandTrie } from "./catalog.js";
import type { CatalogCommand, CommandCatalog, CommandTrieNode } from "./catalog.js";
import { HELP_COMMAND, buildHelpDetail, buildHelpOverview } from "./helpBuilder.js";
import { tokenizeCommandLine } from "./tokenizer.js";
import { argumentDocs, usageLine } from "./usage.js";

export type DispatchStatus = "handled" | "unknown-command" | "invalid-args" | "denied" | "ignored";

export interface DispatchResult {
  status: DispatchStatus;
  commandPath?: readonly string[];
  plugin?: string;
}

export interface RouterInvocation {
  prefix: string;
  mentionAliases: readonly string[];
}

export interface RouterDeps {
  catalog: CommandCatalog;
  replyTo(message: Message, text: string): Promise<unknown>;
  authorizer: Authorizer;
  invocation: RouterInvocation;
  logger?: Logger;
}

export interface CommandInput {
  plugin: string;
  path: readonly string[];
  message: Message;
  args: Record<string, unknown>;
  rawArgs: readonly string[];
}

export interface RouterHandlers {
  runCommand(input: CommandInput): Promise<void>;
}

export interface Router {
  handleMessage(message: Message): Promise<DispatchResult>;
}

type RouteNode = CommandTrieNode;

export function buildRouteTrie(entries: readonly CatalogCommand[]): RouteNode {
  return buildCommandTrie(entries);
}

export function createRouter(deps: RouterDeps, handlers: RouterHandlers): Router {
  async function replyHelp(message: Message): Promise<void> {
    const lines = buildHelpOverview(deps.catalog, { prefix: deps.invocation.prefix });
    await deps.replyTo(message, lines.join("\n"));
  }

  async function helpBranch(message: Message, target: readonly string[]): Promise<DispatchResult> {
    if (target.length === 0) {
      await replyHelp(message);
      return { status: "handled", commandPath: [HELP_COMMAND] };
    }
    const lines = buildHelpDetail(deps.catalog, target, { prefix: deps.invocation.prefix });
    if (lines === null) {
      await deps.replyTo(message, `no help for "${target.join(" ")}"`);
      return { status: "unknown-command", commandPath: [HELP_COMMAND] };
    }
    await deps.replyTo(message, lines.join("\n"));
    return { status: "handled", commandPath: [HELP_COMMAND] };
  }

  async function handleMessage(message: Message): Promise<DispatchResult> {
    const text = message.text.trim();
    const { prefix, mentionAliases } = deps.invocation;

    let cmdline: string | undefined;
    if (text.startsWith(prefix)) {
      cmdline = text.slice(prefix.length);
    } else {
      const alias = [...mentionAliases]
        .filter((candidate) => candidate.length > 0)
        .sort((a, b) => b.length - a.length)
        .find((candidate) => text.toLowerCase().startsWith(candidate.toLowerCase()));
      if (alias !== undefined) cmdline = text.slice(alias.length);
    }
    if (cmdline === undefined) return { status: "ignored" };

    const { tokens } = tokenizeCommandLine(cmdline);
    if (tokens.length === 0) {
      await replyHelp(message);
      return { status: "handled", commandPath: [HELP_COMMAND] };
    }

    if (tokens[0] === HELP_COMMAND) {
      return helpBranch(message, tokens.slice(1));
    }

    const root = buildRouteTrie(deps.catalog.commands());
    let node: RouteNode = root;
    let matched = 0;
    for (const token of tokens) {
      const child = node.children.get(token);
      if (child === undefined) break;
      node = child;
      matched += 1;
    }

    if (matched === 0) {
      await deps.replyTo(message, `unknown command "${tokens[0]!}" - try "${prefix}help"`);
      return { status: "unknown-command" };
    }

    const path = tokens.slice(0, matched);
    const remaining = tokens.slice(matched);
    const shown = path.join(" ");
    const entry = node.entry;

    if (entry === undefined || entry.runnable === false) {
      if (remaining.length > 0) {
        await deps.replyTo(
          message,
          `unknown subcommand "${remaining[0]!}" for "${shown}" - try "${prefix}help ${shown}"`,
        );
      } else {
        await deps.replyTo(message, `"${shown}" needs a subcommand - try "${prefix}help ${shown}"`);
      }
      return { status: "unknown-command", commandPath: path };
    }

    if (entry.permission !== undefined) {
      try {
        await deps.authorizer.assertAllowed(message.author, entry.permission);
      } catch (error: unknown) {
        if (error instanceof PermissionDeniedError) {
          deps.logger?.info("permission denied", {
            user: message.author.username,
            userId: message.author.id,
            commandPath: entry.path.join(" "),
          });
          await deps.replyTo(message, "you don't have permission to run that command");
          return { status: "denied", commandPath: entry.path, plugin: entry.plugin };
        }
        throw error;
      }
    }

    const { args, problems } = parseArguments(entry.args, remaining);
    if (problems.length > 0) {
      const lines: string[] = [`usage: ${prefix}${usageLine(entry.path, entry.args)}`];
      for (const problem of problems) lines.push(`problem: ${problem}`);
      const docs = argumentDocs(entry.args);
      if (docs.length > 0) {
        lines.push("Arguments:");
        for (const doc of docs) lines.push(`  ${doc}`);
      }
      await deps.replyTo(message, lines.join("\n"));
      return { status: "invalid-args", commandPath: entry.path, plugin: entry.plugin };
    }

    await handlers.runCommand({ plugin: entry.plugin, path: entry.path, message, args, rawArgs: remaining });
    return { status: "handled", commandPath: entry.path, plugin: entry.plugin };
  }

  return { handleMessage };
}
