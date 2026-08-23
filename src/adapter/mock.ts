import { BaseAdapter } from "./adapter.js";
import type { AdapterHost, AdapterStartOptions, Capabilities, TypingHandle } from "./adapter.js";
import type { Clock } from "../clock.js";
import type { MockAdapterOptions } from "../config/types.js";
import { AdapterOperationError } from "../errors.js";
import type { Channel, Message, MessageRef, Role, SendOptions, SentMessageRef, User } from "../types.js";

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface SimulateMessageInput {
  userId?: string;
  username?: string;
  channelId: string;
  text: string;
  threadId?: string;
}

export type MockDelivery =
  | { kind: "send"; channelId: string; messageId: string; threadId?: string; text: string; seq: number }
  | { kind: "edit"; messageId: string; channelId: string; text: string; seq: number }
  | { kind: "delete"; messageId: string; channelId: string; seq: number }
  | { kind: "react"; messageId: string; channelId: string; emoji: string; seq: number }
  | { kind: "typingStart" | "typingStop"; channelId: string; seq: number };

export class MockAdapter extends BaseAdapter {
  readonly name = "mock";

  readonly capabilities: Capabilities = {
    send: true,
    edit: true,
    delete: true,
    react: true,
    threads: true,
    typing: true,
    memberEvents: true,
    userLookup: true,
    channelLookup: true,
    roles: true,
  };

  readonly botUser: User;

  private readonly clock: Clock;
  private attachedHost: AdapterHost | null = null;
  private readonly usersById = new Map<string, User>();
  private readonly usersByUsername = new Map<string, User>();
  private readonly channelsById = new Map<string, Channel>();
  private readonly historyByChannel = new Map<string, Message[]>();
  private readonly reactionsByMessage = new Map<string, string[]>();
  private readonly rolesByUser = new Map<string, Role[]>();
  private recordedDeliveries: MockDelivery[] = [];
  private messageCounter = 0;
  private deliveryCounter = 0;

  constructor(options: MockAdapterOptions & { clock?: Clock } = {}) {
    super();
    this.clock = options.clock ?? systemClock;
    this.botUser = { id: options.botUserId ?? "u-plugbot", username: "plugbot", isBot: true };
    this.registerUser(this.botUser);
    this.registerUser({ id: "u-alice", username: "alice" });
    this.registerUser({ id: "u-bob", username: "bob" });
    this.registerUser({ id: "u-carol", username: "carol" });
    this.registerChannel({ id: "general", name: "general", kind: "channel" });
    this.registerChannel({ id: "random", name: "random", kind: "channel" });
    for (const channel of options.channels ?? []) {
      this.registerChannel({ id: channel.id, name: channel.name, kind: "channel" });
    }
    for (const user of options.users ?? []) {
      this.registerUser({ id: user.id, username: user.username, displayName: user.displayName });
    }
    for (const [userId, roles] of Object.entries(options.roles ?? {})) {
      this.rolesByUser.set(userId, [...roles]);
    }
  }

  override async start(host: AdapterHost, _options?: AdapterStartOptions): Promise<void> {
    this.attachedHost = host;
  }

  override async stop(): Promise<void> {}

  async send(channelId: string, text: string, options?: SendOptions): Promise<SentMessageRef> {
    this.requireChannel(channelId, "send");
    const messageId = this.nextMessageId();
    const message: Message = {
      id: messageId,
      text,
      author: this.botUser,
      channelId,
      threadId: options?.threadId,
      createdAt: this.clock.now(),
      mentions: [],
    };
    this.historyOf(channelId).push(message);
    this.recordedDeliveries.push({
      kind: "send",
      channelId,
      messageId,
      threadId: options?.threadId,
      text,
      seq: this.nextDeliverySeq(),
    });
    return { channelId, messageId, threadId: options?.threadId };
  }

  override async editMessage(ref: MessageRef, text: string): Promise<void> {
    const message = this.findMessage(ref);
    if (!message) {
      throw new AdapterOperationError(this.name, "editMessage", new Error(`unknown message "${ref.messageId}"`));
    }
    message.text = text;
    this.recordedDeliveries.push({
      kind: "edit",
      messageId: ref.messageId,
      channelId: ref.channelId,
      text,
      seq: this.nextDeliverySeq(),
    });
  }

  override async deleteMessage(ref: MessageRef): Promise<void> {
    const history = this.historyByChannel.get(ref.channelId);
    const index = history?.findIndex((candidate) => candidate.id === ref.messageId) ?? -1;
    if (!history || index < 0) {
      throw new AdapterOperationError(this.name, "deleteMessage", new Error(`unknown message "${ref.messageId}"`));
    }
    history.splice(index, 1);
    this.reactionsByMessage.delete(ref.messageId);
    this.recordedDeliveries.push({
      kind: "delete",
      messageId: ref.messageId,
      channelId: ref.channelId,
      seq: this.nextDeliverySeq(),
    });
  }

  override async react(ref: MessageRef, emoji: string): Promise<void> {
    const message = this.findMessage(ref);
    if (!message) {
      throw new AdapterOperationError(this.name, "react", new Error(`unknown message "${ref.messageId}"`));
    }
    let reactions = this.reactionsByMessage.get(ref.messageId);
    if (!reactions) {
      reactions = [];
      this.reactionsByMessage.set(ref.messageId, reactions);
    }
    if (!reactions.includes(emoji)) reactions.push(emoji);
    this.recordedDeliveries.push({
      kind: "react",
      messageId: ref.messageId,
      channelId: ref.channelId,
      emoji,
      seq: this.nextDeliverySeq(),
    });
  }

  override async startTyping(channelId: string): Promise<TypingHandle> {
    this.requireChannel(channelId, "startTyping");
    this.recordedDeliveries.push({ kind: "typingStart", channelId, seq: this.nextDeliverySeq() });
    return {
      stop: async () => {
        this.recordedDeliveries.push({ kind: "typingStop", channelId, seq: this.nextDeliverySeq() });
      },
    };
  }

  override async getUser(userId: string): Promise<User | null> {
    return this.usersById.get(userId) ?? null;
  }

  override async getChannel(channelId: string): Promise<Channel | null> {
    return this.channelsById.get(channelId) ?? null;
  }

  override async resolveRoles(userId: string): Promise<readonly Role[]> {
    const roles = this.rolesByUser.get(userId);
    return roles ? [...roles] : [];
  }

  setRoles(userId: string, roles: readonly Role[]): void {
    this.rolesByUser.set(userId, [...roles]);
  }

  simulateMessage(input: SimulateMessageInput): Message {
    const host = this.attachedHost;
    if (!host) {
      throw new AdapterOperationError(this.name, "simulateMessage", new Error("adapter not started"));
    }
    this.requireChannel(input.channelId, "simulateMessage");
    const author = this.authorFor(input.userId, input.username);
    const message: Message = {
      id: this.nextMessageId(),
      text: input.text,
      author,
      channelId: input.channelId,
      threadId: input.threadId,
      createdAt: this.clock.now(),
      mentions: this.parseMentions(input.text),
    };
    this.historyOf(input.channelId).push(message);
    host.dispatch({ type: "message", at: message.createdAt, message });
    return message;
  }

  simulateJoin(userId: string, channelId: string): void {
    this.dispatchMembership("memberJoin", userId, channelId);
  }

  simulateLeave(userId: string, channelId: string): void {
    this.dispatchMembership("memberLeave", userId, channelId);
  }

  deliveries(): readonly MockDelivery[] {
    return this.recordedDeliveries;
  }

  clearDeliveries(): void {
    this.recordedDeliveries = [];
  }

  history(channelId: string): readonly Message[] {
    return this.historyByChannel.get(channelId) ?? [];
  }

  reactionsOf(messageId: string): readonly string[] {
    return this.reactionsByMessage.get(messageId) ?? [];
  }

  private dispatchMembership(type: "memberJoin" | "memberLeave", userId: string, channelId: string): void {
    const host = this.attachedHost;
    if (!host) {
      throw new AdapterOperationError(this.name, type, new Error("adapter not started"));
    }
    this.requireChannel(channelId, type);
    this.authorFor(userId, undefined);
    const at = this.clock.now();
    if (type === "memberJoin") host.dispatch({ type, at, userId, channelId });
    else host.dispatch({ type, at, userId, channelId });
  }

  private requireChannel(channelId: string, operation: string): void {
    if (!this.channelsById.has(channelId)) {
      throw new AdapterOperationError(this.name, operation, new Error(`unknown channel "${channelId}"`));
    }
  }

  private findMessage(ref: MessageRef): Message | undefined {
    return this.historyByChannel.get(ref.channelId)?.find((candidate) => candidate.id === ref.messageId);
  }

  private historyOf(channelId: string): Message[] {
    const existing = this.historyByChannel.get(channelId);
    if (existing) return existing;
    const created: Message[] = [];
    this.historyByChannel.set(channelId, created);
    return created;
  }

  private authorFor(userId: string | undefined, username: string | undefined): User {
    if (userId !== undefined) {
      const byId = this.usersById.get(userId);
      if (byId) return byId;
    }
    if (username !== undefined) {
      const byUsername = this.usersByUsername.get(username);
      if (byUsername) return byUsername;
    }
    const resolvedUsername = username ?? userId ?? "anon";
    const resolvedId = userId ?? `u-${resolvedUsername}`;
    const user: User = { id: resolvedId, username: resolvedUsername };
    this.registerUser(user);
    return user;
  }

  private parseMentions(text: string): string[] {
    const mentions: string[] = [];
    for (const token of text.split(/\s+/)) {
      const matched = /^@([\w-]+)$/.exec(token);
      const username = matched?.[1];
      if (username === undefined) continue;
      const user = this.usersByUsername.get(username);
      if (user && !mentions.includes(user.id)) mentions.push(user.id);
    }
    return mentions;
  }

  private registerUser(user: User): void {
    this.usersById.set(user.id, user);
    this.usersByUsername.set(user.username, user);
  }

  private registerChannel(channel: Channel): void {
    this.channelsById.set(channel.id, channel);
  }

  private nextMessageId(): string {
    this.messageCounter += 1;
    return `m${String(this.messageCounter).padStart(6, "0")}`;
  }

  private nextDeliverySeq(): number {
    this.deliveryCounter += 1;
    return this.deliveryCounter;
  }
}
