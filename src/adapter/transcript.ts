import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BaseAdapter } from "./adapter.js";
import type { AdapterHost, AdapterStartOptions, Capabilities } from "./adapter.js";
import type { Clock } from "../clock.js";
import type { TranscriptAdapterOptions } from "../config/types.js";
import { AdapterOperationError, ConfigError } from "../errors.js";
import type { Channel, Message, Role, SendOptions, SentMessageRef, User } from "../types.js";

const BOT_USERNAME = "plugbot";
const REPLAY_EPOCH_MS = 1767225600000;
const REPLAY_LINE_STEP_MS = 1000;

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface TranscriptAdapterParams extends Omit<TranscriptAdapterOptions, "transcriptFile"> {
  transcriptFile?: string;
  transcriptText?: string;
  clock?: Clock;
}

type ParsedEntry =
  | { kind: "message"; username: string; channelId: string; dmTarget: string | null; text: string }
  | { kind: "join"; username: string; channelId: string }
  | { kind: "leave"; username: string; channelId: string };

type ReplayEntry =
  | { kind: "message"; author: User; channelId: string; text: string; mentions: string[] }
  | { kind: "join"; user: User; channelId: string }
  | { kind: "leave"; user: User; channelId: string };

type ReplayMessageEntry = Extract<ReplayEntry, { kind: "message" }>;

function group(match: RegExpExecArray, position: number): string {
  const value = match[position];
  if (value === undefined) throw new Error(`regex group ${position} missing`);
  return value;
}

function parseEntry(line: string, fileName: string, lineNo: number): ParsedEntry {
  const message = /^(\S+) -> ([#@])(\S+): (.*)$/.exec(line);
  if (message) {
    const username = group(message, 1);
    const marker = group(message, 2);
    const target = group(message, 3);
    const text = group(message, 4);
    if (marker === "#") return { kind: "message", username, channelId: target, dmTarget: null, text };
    return { kind: "message", username, channelId: `dm:${username}`, dmTarget: target, text };
  }
  const join = /^join (\S+) #(\S+)$/.exec(line);
  if (join) {
    return { kind: "join", username: group(join, 1), channelId: group(join, 2) };
  }
  const leave = /^leave (\S+) #(\S+)$/.exec(line);
  if (leave) {
    return { kind: "leave", username: group(leave, 1), channelId: group(leave, 2) };
  }
  throw new ConfigError(`${fileName}: line ${lineNo}: unrecognized transcript line "${line}"`, {
    file: fileName,
    line: lineNo,
  });
}

function parseTranscript(source: string, fileName: string): { entries: ParsedEntry[]; firstUsername: string | null } {
  const entries: ParsedEntry[] = [];
  let firstUsername: string | null = null;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const entry = parseEntry(line, fileName, index + 1);
    if (firstUsername === null) firstUsername = entry.username;
    entries.push(entry);
  }
  return { entries, firstUsername };
}

export class TranscriptAdapter extends BaseAdapter {
  readonly name = "transcript";

  readonly capabilities: Capabilities = {
    send: true,
    edit: false,
    delete: false,
    react: false,
    threads: true,
    typing: false,
    memberEvents: true,
    userLookup: true,
    channelLookup: true,
    roles: true,
  };

  private readonly transcriptFile?: string;
  private readonly transcriptText?: string;
  private readonly recordFile?: string;
  private readonly paceMs: number;
  private readonly clock: Clock;
  private readonly usersById = new Map<string, User>();
  private readonly channelsById = new Map<string, Channel>();
  private recordedOutput: string[] = [];
  private messageCounter = 0;
  private firstUserId: string | null = null;

  constructor(options: TranscriptAdapterParams) {
    super();
    this.transcriptFile = options.transcriptFile;
    this.transcriptText = options.transcriptText;
    this.recordFile = options.recordFile;
    this.paceMs = options.paceMs ?? 0;
    this.clock = options.clock ?? systemClock;
  }

  override async start(host: AdapterHost, _options?: AdapterStartOptions): Promise<void> {
    this.ensureUser(BOT_USERNAME);
    const source = this.loadSource();
    const parsed = parseTranscript(source.text, source.fileName);
    if (parsed.firstUsername !== null) this.firstUserId = `u-${parsed.firstUsername}`;
    const plan = this.buildPlan(parsed.entries);
    await this.replay(host, plan);
  }

  async send(channelId: string, text: string, options?: SendOptions): Promise<SentMessageRef> {
    const suffix = options?.threadId === undefined ? "" : ` [thread=${options.threadId}]`;
    const line = `${BOT_USERNAME} -> #${channelId}: ${text}${suffix}`;
    this.ensureChannel(channelId, "channel", channelId);
    this.recordedOutput.push(line);
    this.persistLine(line);
    const messageId = this.nextMessageId();
    return { channelId, messageId, threadId: options?.threadId };
  }

  override async getUser(userId: string): Promise<User | null> {
    return this.usersById.get(userId) ?? null;
  }

  override async getChannel(channelId: string): Promise<Channel | null> {
    return this.channelsById.get(channelId) ?? null;
  }

  override async resolveRoles(userId: string): Promise<readonly Role[]> {
    return this.firstUserId !== null && userId === this.firstUserId ? ["admin"] : [];
  }

  recordedLines(): readonly string[] {
    return this.recordedOutput;
  }

  reset(): void {
    this.recordedOutput = [];
  }

  private loadSource(): { text: string; fileName: string } {
    if (this.transcriptText !== undefined) {
      return { text: this.transcriptText, fileName: this.transcriptFile ?? "<transcriptText>" };
    }
    if (this.transcriptFile === undefined) {
      throw new ConfigError(
        'missing required key "adapter.options.transcriptFile": provide transcriptFile or transcriptText',
        { key: "adapter.options.transcriptFile" },
      );
    }
    try {
      return { text: readFileSync(this.transcriptFile, "utf8"), fileName: this.transcriptFile };
    } catch (cause) {
      throw new ConfigError(
        `adapter.options.transcriptFile: cannot read transcript file "${this.transcriptFile}"`,
        { key: "adapter.options.transcriptFile", file: this.transcriptFile, reason: String(cause) },
      );
    }
  }

  private buildPlan(entries: ParsedEntry[]): ReplayEntry[] {
    const knownUsernames = new Set<string>([BOT_USERNAME]);
    for (const entry of entries) {
      knownUsernames.add(entry.username);
      if (entry.kind !== "message") continue;
      if (entry.dmTarget !== null) knownUsernames.add(entry.dmTarget);
      for (const token of entry.text.split(/\s+/)) {
        const matched = /^@([\w-]+)$/.exec(token);
        const username = matched?.[1];
        if (username !== undefined) knownUsernames.add(username);
      }
    }
    for (const username of knownUsernames) this.ensureUser(username);
    const plan: ReplayEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === "message") {
        const author = this.ensureUser(entry.username);
        const isDm = entry.dmTarget !== null;
        const channelKind = isDm ? "dm" : "channel";
        const channelName = isDm ? entry.username : entry.channelId;
        this.ensureChannel(entry.channelId, channelKind, channelName);
        plan.push({
          kind: "message",
          author,
          channelId: entry.channelId,
          text: entry.text,
          mentions: this.planMentions(entry.text, knownUsernames),
        });
      } else {
        const user = this.ensureUser(entry.username);
        this.ensureChannel(entry.channelId, "channel", entry.channelId);
        plan.push(
          entry.kind === "join"
            ? { kind: "join", user, channelId: entry.channelId }
            : { kind: "leave", user, channelId: entry.channelId },
        );
      }
    }
    return plan;
  }

  private planMentions(text: string, knownUsernames: Set<string>): string[] {
    const mentions: string[] = [];
    for (const token of text.split(/\s+/)) {
      const matched = /^@([\w-]+)$/.exec(token);
      const username = matched?.[1];
      if (username === undefined) continue;
      const userId = `u-${username}`;
      if (knownUsernames.has(username) && !mentions.includes(userId)) mentions.push(userId);
    }
    return mentions;
  }

  private async replay(host: AdapterHost, plan: ReplayEntry[]): Promise<void> {
    for (const [index, entry] of plan.entries()) {
      if (index > 0) {
        if (this.paceMs > 0) await this.pause(this.paceMs);
        else await Promise.resolve();
      }
      const at = REPLAY_EPOCH_MS + index * REPLAY_LINE_STEP_MS;
      if (entry.kind === "message") {
        host.dispatch({ type: "message", at, message: this.buildMessage(entry, at) });
      } else if (entry.kind === "join") {
        host.dispatch({ type: "memberJoin", at, userId: entry.user.id, channelId: entry.channelId });
      } else {
        host.dispatch({ type: "memberLeave", at, userId: entry.user.id, channelId: entry.channelId });
      }
    }
  }

  private buildMessage(entry: ReplayMessageEntry, at: number): Message {
    return {
      id: this.nextMessageId(),
      text: entry.text,
      author: entry.author,
      channelId: entry.channelId,
      createdAt: at,
      mentions: entry.mentions,
    };
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimeout(resolve, ms);
    });
  }

  private persistLine(line: string): void {
    if (this.recordFile === undefined) return;
    try {
      mkdirSync(dirname(this.recordFile), { recursive: true });
      appendFileSync(this.recordFile, `${line}\n`, "utf8");
    } catch (cause) {
      throw new AdapterOperationError(this.name, "send", cause);
    }
  }

  private ensureUser(username: string): User {
    const userId = `u-${username}`;
    const existing = this.usersById.get(userId);
    if (existing) return existing;
    const user: User = { id: userId, username };
    if (username === BOT_USERNAME) user.isBot = true;
    this.usersById.set(userId, user);
    return user;
  }

  private ensureChannel(channelId: string, kind: Channel["kind"], name: string): Channel {
    const existing = this.channelsById.get(channelId);
    if (existing) return existing;
    const channel: Channel = { id: channelId, name, kind };
    this.channelsById.set(channelId, channel);
    return channel;
  }

  private nextMessageId(): string {
    this.messageCounter += 1;
    return `t${String(this.messageCounter).padStart(6, "0")}`;
  }
}
