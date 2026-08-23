import * as net from "node:net";
import type { Clock, ClockTimeout } from "../../clock.js";
import { AdapterOperationError, CapabilityError, ConfigError } from "../../errors.js";
import type { PlugbotError } from "../../errors.js";
import { BaseAdapter } from "../adapter.js";
import type { AdapterHost, AdapterStartOptions, Capabilities } from "../adapter.js";
import type { IrcAdapterOptions } from "../../config/types.js";
import type { BotEvent, Channel, Role, SendOptions, SentMessageRef } from "../../types.js";
import { nextDelayMs } from "./reconnectPolicy.js";
import { TokenBucket } from "./tokenBucket.js";

const LINE_SEPARATOR = "\r\n";
const DEFAULT_KEEP_ALIVE_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;
const MAX_PRIVMSG_BYTES = 400;
const ELLIPSIS_MARKER = "...";
const ACTION_MARKER = "\u0001ACTION ";
const CTCP_DELIMITER = "\u0001";

const DEFAULT_RECONNECT_OPTIONS: Readonly<{ initialDelayMs: number; maxDelayMs: number }> = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
};

const DEFAULT_RATE_LIMIT: Readonly<{ messagesPerSecond: number; burst: number }> = {
  messagesPerSecond: 1,
  burst: 4,
};

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (handler: () => void, ms: number): ClockTimeout => {
    const timer = setTimeout(handler, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

interface IrcLine {
  prefix: string | null;
  command: string;
  params: string[];
}

interface ChannelState {
  id: string;
  joined: boolean;
  members: Map<string, string>;
  roles: Map<string, Role[]>;
}

interface SendTicket {
  reject: (error: PlugbotError) => void;
}

interface IrcAdapterDeps {
  clock?: Clock;
  socketFactory?: (host: string, port: number) => net.Socket;
  random?: () => number;
}

function parseIrcLine(line: string): IrcLine | null {
  let rest = line.trim();
  let prefix: string | null = null;
  if (rest.startsWith(":")) {
    const separatorIndex = rest.indexOf(" ");
    if (separatorIndex === -1) return null;
    prefix = rest.slice(1, separatorIndex);
    rest = rest.slice(separatorIndex + 1).trimStart();
  }
  if (rest.length === 0) return null;
  const headSeparator = rest.indexOf(" ");
  const command = (headSeparator === -1 ? rest : rest.slice(0, headSeparator)).toUpperCase();
  const params: string[] = [];
  if (headSeparator !== -1) {
    let remaining = rest.slice(headSeparator + 1);
    while (remaining.length > 0) {
      if (remaining.startsWith(":")) {
        params.push(remaining.slice(1));
        break;
      }
      const spaceIndex = remaining.indexOf(" ");
      if (spaceIndex === -1) {
        params.push(remaining);
        break;
      }
      if (spaceIndex > 0) params.push(remaining.slice(0, spaceIndex));
      remaining = remaining.slice(spaceIndex + 1).trimStart();
    }
  }
  return { prefix, command, params };
}

function prefixNick(prefix: string): string {
  const exclamationIndex = prefix.indexOf("!");
  return exclamationIndex === -1 ? prefix : prefix.slice(0, exclamationIndex);
}

function splitNamesToken(token: string): { nick: string; roles: Role[] } {
  let index = 0;
  const roles: Role[] = [];
  while (index < token.length) {
    const character = token[index];
    if (character === "@") {
      roles.push("admin");
    } else if (character === "+") {
      roles.push("voice");
    } else if (character !== undefined && "~&%".includes(character)) {
      // owner/channel-founder/half-op prefixes carry no framework role
    } else {
      break;
    }
    index += 1;
  }
  return { nick: token.slice(index), roles };
}

function sanitizeLineBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/** Truncates to at most maxBytes utf-8 bytes, appending an ASCII ellipsis marker. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const markerSize = Buffer.byteLength(ELLIPSIS_MARKER, "utf8");
  const budget = maxBytes - markerSize;
  let kept = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > budget) break;
    kept += character;
    used += size;
  }
  return `${kept}${ELLIPSIS_MARKER}`;
}

function extractMentions(text: string, members: Map<string, string>): string[] {
  const mentions: string[] = [];
  const pattern = /@([\w[\]\\^{}|-]+)/g;
  for (const match of text.matchAll(pattern)) {
    const nickKey = (match[1] ?? "").toLowerCase();
    const canonical = members.get(nickKey);
    if (canonical !== undefined && !mentions.includes(`irc:${canonical}`)) {
      mentions.push(`irc:${canonical}`);
    }
  }
  return mentions;
}

export class IrcAdapter extends BaseAdapter {
  readonly name = "irc";

  readonly capabilities: Capabilities = {
    send: true,
    edit: false,
    delete: false,
    react: false,
    threads: false,
    typing: false,
    memberEvents: true,
    userLookup: false,
    channelLookup: true,
    roles: true,
  };

  private readonly options: IrcAdapterOptions;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly socketFactory: (host: string, port: number) => net.Socket;
  private readonly bucket: TokenBucket;

  private hostRef: AdapterHost | null = null;
  private socket: net.Socket | null = null;
  private started = false;
  private running = false;
  private stopping = false;
  private stopped = false;
  private registered = false;
  private nick: string;
  private renamedOnce = false;
  private readonly channels = new Map<string, ChannelState>();
  private autoJoinChannels: string[] = [];
  private messageCounter = 0;
  private pingSequence = 0;
  private lineBuffer = "";
  private lastWriteError: string | null = null;
  private lastTrafficMs = 0;
  private connectionEstablishedMs = 0;
  private pendingPongToken: string | null = null;
  private pendingPongSentMs = 0;
  private attempt = 0;
  private reconnectTimer: ClockTimeout | null = null;
  private keepAliveTimer: ClockTimeout | null = null;
  private startResolve: (() => void) | null = null;
  private startReject: ((error: PlugbotError) => void) | null = null;
  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly sendTickets = new Set<SendTicket>();

  constructor(options: IrcAdapterOptions, deps?: IrcAdapterDeps) {
    super();
    this.options = options;
    this.nick = options.nick;
    this.clock = deps?.clock ?? SYSTEM_CLOCK;
    this.random = deps?.random ?? Math.random;
    if (options.outboundRateLimit !== undefined) {
      const { messagesPerSecond, burst } = options.outboundRateLimit;
      const invalid: string[] = [];
      if (!Number.isFinite(messagesPerSecond) || messagesPerSecond <= 0) {
        invalid.push(`adapter.options.outboundRateLimit.messagesPerSecond must be a positive number, got ${messagesPerSecond}`);
      }
      if (!Number.isFinite(burst) || burst <= 0) {
        invalid.push(`adapter.options.outboundRateLimit.burst must be a positive number, got ${burst}`);
      }
      if (invalid.length > 0) throw new ConfigError(invalid.join("; "), { source: "adapter.options" });
    }
    this.socketFactory =
      deps?.socketFactory ?? ((host: string, port: number) => net.connect({ host, port }));
    const rateLimit = options.outboundRateLimit ?? DEFAULT_RATE_LIMIT;
    this.bucket = new TokenBucket(rateLimit.messagesPerSecond, rateLimit.burst, this.clock);
  }

  override async start(host: AdapterHost, startOptions?: AdapterStartOptions): Promise<void> {
    if (this.started || this.stopping) {
      throw new AdapterOperationError(this.name, "start", new Error("adapter already started"));
    }
    this.started = true;
    this.hostRef = host;
    this.autoJoinChannels = mergeUnique([
      ...(startOptions?.autoJoin ?? []),
      ...(this.options.autoJoin ?? []),
    ]);
    await new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.openConnection();
    });
  }

  override async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    if (this.stopPromise !== null) return this.stopPromise;
    this.stopPromise = this.performStop();
    await this.stopPromise;
  }

  override async send(
    channelId: string,
    text: string,
    sendOptions?: SendOptions,
  ): Promise<SentMessageRef> {
    if (sendOptions?.threadId !== undefined) {
      throw new CapabilityError(this.name, "threads");
    }
    const target = this.resolveSendTarget(channelId);
    await this.acquireSendSlot();
    const overheadBytes = Buffer.byteLength(`PRIVMSG ${target} :`, "utf8");
    const payloadBudget = Math.max(64, MAX_PRIVMSG_BYTES - overheadBytes);
    const payload = truncateToBytes(sanitizeLineBreaks(text.replace(/\0/g, "")), payloadBudget);
    try {
      this.writeLine(`PRIVMSG ${target} :${payload}`);
    } catch (cause) {
      throw new AdapterOperationError(this.name, "send", cause, {
        reconnecting: this.expectsReconnect(),
      });
    }
    this.messageCounter += 1;
    return { channelId, messageId: `irc-${this.messageCounter}` };
  }

  override async getChannel(channelId: string): Promise<Channel | null> {
    const state = this.channels.get(channelId.toLowerCase());
    if (state === undefined || !state.joined) return null;
    return { id: state.id, name: state.id, kind: "channel" };
  }

  override async resolveRoles(userId: string, channelId?: string): Promise<readonly Role[]> {
    if (channelId === undefined || channelId.length === 0) return [];
    const state = this.channels.get(channelId.toLowerCase());
    if (state === undefined || !state.joined) return [];
    const nick = userId.startsWith("irc:") ? userId.slice("irc:".length) : userId;
    return state.roles.get(nick.toLowerCase()) ?? [];
  }

  private performStop(): Promise<void> {
    this.stopping = true;
    this.cancelTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cancelTimer(this.keepAliveTimer);
    this.keepAliveTimer = null;
    return new Promise<void>((resolve) => {
      const socket = this.socket;
      if (socket === null) {
        this.finalizeStop();
        resolve();
        return;
      }
      this.stopResolve = resolve;
      try {
        this.writeLine("QUIT :leaving");
      } catch {
        // close event finalises regardless
      }
      socket.end();
    });
  }

  private finalizeStop(): void {
    this.stopping = false;
    this.stopped = true;
    this.running = false;
    this.registered = false;
    this.failInFlightSends(new AdapterOperationError(this.name, "send", new Error("adapter stopped")));
    this.socket?.destroy();
    this.socket = null;
    this.channels.clear();
    const resolve = this.stopResolve;
    this.stopResolve = null;
    resolve?.();
  }

  private openConnection(): void {
    this.registered = false;
    this.running = false;
    this.renamedOnce = false;
    this.lineBuffer = "";
    this.pendingPongToken = null;
    const nowMs = this.clock.now();
    this.lastTrafficMs = nowMs;
    this.connectionEstablishedMs = nowMs;
    const socket = this.socketFactory(this.options.server, this.options.port);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.lastTrafficMs = this.clock.now();
      this.writeLine(`NICK ${this.nick}`);
      this.writeLine(
        `USER ${this.options.username ?? this.options.nick} 0 * :${this.options.realName ?? this.options.nick}`,
      );
    });
    socket.on("data", (chunk: string) => this.onChunk(chunk));
    socket.on("error", () => {
      // close drives the reconnect path; errors surface there
    });
    socket.on("close", () => this.onDisconnected());
  }

  private onChunk(chunk: string): void {
    this.lastTrafficMs = this.clock.now();
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let raw = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (raw.length > 0) this.onLine(raw);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  private onLine(raw: string): void {
    const parsed = parseIrcLine(raw);
    if (parsed === null) return;
    switch (parsed.command) {
      case "PING":
        this.writeLineSafe(`PONG ${parsed.params.join(" ")}`);
        return;
      case "PONG":
        this.handlePong(parsed.params.join(" "));
        return;
      case "PRIVMSG":
        this.handlePrivmsg(parsed);
        return;
      case "JOIN":
        this.handleJoin(parsed);
        return;
      case "PART":
        this.handlePart(parsed);
        return;
      case "NICK":
        this.handleNickChange(parsed);
        return;
      case "QUIT":
        this.handleQuit(parsed);
        return;
      case "ERROR":
        this.destroySocket();
        return;
      default:
        if (/^\d{3}$/.test(parsed.command)) this.handleNumeric(parsed.command, parsed.params);
        return;
    }
  }

  private handleNumeric(code: string, params: string[]): void {
    switch (code) {
      case "001":
        this.onRegistered();
        return;
      case "353":
        this.handleNames(params);
        return;
      case "433":
        this.handleNickInUse();
        return;
      default:
        return;
    }
  }

  private onRegistered(): void {
    this.registered = true;
    this.running = true;
    this.connectionEstablishedMs = this.clock.now();
    for (const channel of this.autoJoinChannels) {
      const state = this.ensureChannel(channel);
      state.joined = true;
      state.members.set(this.nick.toLowerCase(), this.nick);
    }
    this.armKeepAlive();
    const resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    resolve?.();
    void this.joinAutoJoinChannels();
  }

  private async joinAutoJoinChannels(): Promise<void> {
    for (const channel of this.autoJoinChannels) {
      await this.bucket.take();
      if (!this.isConnected()) return;
      this.writeLineSafe(`JOIN ${channel}`);
    }
  }

  private handleNames(params: string[]): void {
    const hasSymbolParam = params.length >= 4;
    const channelId = hasSymbolParam ? params[2] : params[1];
    const namesText = hasSymbolParam ? params[3] : params[2];
    if (channelId === undefined || namesText === undefined) return;
    const state = this.ensureChannel(channelId);
    for (const token of namesText.split(" ")) {
      if (token.length === 0) continue;
      const { nick, roles } = splitNamesToken(token);
      if (nick.length === 0) continue;
      state.members.set(nick.toLowerCase(), nick);
      if (roles.length > 0) state.roles.set(nick.toLowerCase(), roles);
    }
  }

  private handleNickInUse(): void {
    if (this.registered) return;
    if (!this.renamedOnce) {
      this.renamedOnce = true;
      this.nick = `${this.nick}_`;
      this.writeLineSafe(`NICK ${this.nick}`);
      return;
    }
    const failure = new AdapterOperationError(
      this.name,
      "start",
      new Error(`nick "${this.nick}" is in use`),
    );
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    this.running = false;
    reject?.(failure);
    this.destroySocket();
  }

  private handlePrivmsg(parsed: IrcLine): void {
    if (parsed.prefix === null) return;
    const sender = prefixNick(parsed.prefix);
    const target = parsed.params[0];
    const rawText = parsed.params[1] ?? "";
    if (target === undefined) return;
    const isChannel = target.startsWith("#") || target.startsWith("&");
    const channelId = isChannel ? target : `dm:${sender}`;
    const body = normalizeAction(rawText);
    const members =
      this.channels.get(target.toLowerCase())?.members ??
      new Map<string, string>([[sender.toLowerCase(), sender]]);
    const message = {
      id: `irc-${(this.messageCounter += 1)}`,
      text: body,
      author: { id: `irc:${sender}`, username: sender },
      channelId,
      createdAt: this.clock.now(),
      mentions: extractMentions(body, members),
    };
    this.dispatch({ type: "message", at: this.clock.now(), message });
  }

  private handleJoin(parsed: IrcLine): void {
    if (parsed.prefix === null) return;
    const nick = prefixNick(parsed.prefix);
    const channelId = parsed.params[0];
    if (channelId === undefined) return;
    const state = this.ensureChannel(channelId);
    if (nick.toLowerCase() === this.nick.toLowerCase()) {
      state.joined = true;
      state.members.set(this.nick.toLowerCase(), this.nick);
      return;
    }
    state.members.set(nick.toLowerCase(), nick);
    this.dispatch({
      type: "memberJoin",
      at: this.clock.now(),
      userId: `irc:${nick}`,
      channelId: state.id,
    });
  }

  private handlePart(parsed: IrcLine): void {
    if (parsed.prefix === null) return;
    const nick = prefixNick(parsed.prefix);
    const channelId = parsed.params[0];
    if (channelId === undefined) return;
    const key = channelId.toLowerCase();
    const state = this.channels.get(key);
    if (state === undefined) return;
    if (nick.toLowerCase() === this.nick.toLowerCase()) {
      this.channels.delete(key);
      return;
    }
    state.members.delete(nick.toLowerCase());
    state.roles.delete(nick.toLowerCase());
    this.dispatch({
      type: "memberLeave",
      at: this.clock.now(),
      userId: `irc:${nick}`,
      channelId: state.id,
    });
  }

  private handleNickChange(parsed: IrcLine): void {
    if (parsed.prefix === null) return;
    const oldNick = prefixNick(parsed.prefix);
    const newNick = parsed.params[0];
    if (newNick === undefined || newNick.length === 0) return;
    const oldKey = oldNick.toLowerCase();
    const newKey = newNick.toLowerCase();
    for (const state of this.channels.values()) {
      const canonical = state.members.get(oldKey);
      if (canonical !== undefined) {
        state.members.delete(oldKey);
        state.members.set(newKey, newNick);
      }
      const roles = state.roles.get(oldKey);
      if (roles !== undefined) {
        state.roles.delete(oldKey);
        state.roles.set(newKey, roles);
      }
    }
    if (oldKey === this.nick.toLowerCase()) this.nick = newNick;
  }

  private handleQuit(parsed: IrcLine): void {
    if (parsed.prefix === null) return;
    const nick = prefixNick(parsed.prefix);
    const key = nick.toLowerCase();
    for (const state of this.channels.values()) {
      if (!state.members.has(key)) continue;
      state.members.delete(key);
      state.roles.delete(key);
      this.dispatch({
        type: "memberLeave",
        at: this.clock.now(),
        userId: `irc:${nick}`,
        channelId: state.id,
      });
    }
  }

  private handlePong(text: string): void {
    if (this.pendingPongToken !== null && text.includes(this.pendingPongToken)) {
      this.pendingPongToken = null;
    }
  }

  private armKeepAlive(): void {
    const period = this.options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
    const tick = (): void => {
      if (!this.isConnected()) return;
      const nowMs = this.clock.now();
      if (this.pendingPongToken !== null) {
        if (nowMs - this.pendingPongSentMs >= period * 2) {
          this.destroySocket();
          return;
        }
      } else if (nowMs - this.lastTrafficMs >= period) {
        this.pingSequence += 1;
        this.pendingPongToken = `plugbot-${this.pingSequence}`;
        this.pendingPongSentMs = nowMs;
        this.writeLineSafe(`PING ${this.pendingPongToken}`);
      }
      this.keepAliveTimer = this.clock.setTimeout(tick, period);
    };
    this.keepAliveTimer = this.clock.setTimeout(tick, period);
  }

  private onDisconnected(): void {
    this.socket = null;
    this.registered = false;
    this.running = false;
    this.pendingPongToken = null;
    this.cancelTimer(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.lineBuffer = "";
    this.channels.clear();

    if (this.startReject !== null) {
      const reject = this.startReject;
      this.startResolve = null;
      this.startReject = null;
      reject(new AdapterOperationError(this.name, "start", new Error("connection lost")));
      return;
    }

    if (this.stopping || !this.started) {
      this.finalizeStop();
      return;
    }

    this.failInFlightSends(
      new AdapterOperationError(this.name, "send", new Error("connection lost"), {
        reconnecting: true,
      }),
    );

    if (this.clock.now() - this.connectionEstablishedMs >= STABLE_CONNECTION_MS) {
      this.attempt = 0;
    }
    const delayMs = nextDelayMs(this.attempt, this.reconnectOptions(), this.random);
    this.attempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.stopping || !this.started) return;
      this.openConnection();
    }, delayMs);
  }

  private failInFlightSends(error: PlugbotError): void {
    const tickets = [...this.sendTickets];
    this.sendTickets.clear();
    for (const ticket of tickets) ticket.reject(error);
    this.bucket.cancelPending();
  }

  private destroySocket(): void {
    this.socket?.destroy();
  }

  private isConnected(): boolean {
    const socket = this.socket;
    return (
      socket !== null &&
      !socket.destroyed &&
      this.registered &&
      !this.stopping &&
      !this.stopped &&
      this.started
    );
  }

  private expectsReconnect(): boolean {
    return this.started && !this.stopped && !this.stopping && !this.isConnected();
  }

  private resolveSendTarget(channelId: string): string {
    if (channelId.startsWith("dm:")) {
      const nick = channelId.slice("dm:".length);
      if (nick.length === 0) {
        throw new AdapterOperationError(
          this.name,
          "send",
          new Error(`invalid direct-message channel "${channelId}"`),
        );
      }
      return nick;
    }
    const state = this.channels.get(channelId.toLowerCase());
    if (state === undefined || !state.joined) {
      throw new AdapterOperationError(
        this.name,
        "send",
        new Error(`unknown or unjoined channel "${channelId}"`),
      );
    }
    return state.id;
  }

  private async acquireSendSlot(): Promise<void> {
    const upfront = this.sendBlocker();
    if (upfront !== null) throw upfront;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ticket: SendTicket = {
        reject: (error: PlugbotError) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };
      this.sendTickets.add(ticket);
      void this.bucket.take().then(() => {
        if (settled) return;
        settled = true;
        this.sendTickets.delete(ticket);
        const blocker = this.sendBlocker();
        if (blocker !== null) reject(blocker);
        else resolve();
      });
    });
  }

  private sendBlocker(): PlugbotError | null {
    if (this.stopped || this.stopping || !this.started) {
      return new AdapterOperationError(this.name, "send", new Error("adapter stopped"));
    }
    if (!this.isConnected()) {
      return new AdapterOperationError(this.name, "send", new Error("connection unavailable"), {
        reconnecting: true,
      });
    }
    return null;
  }

  private ensureChannel(channelId: string): ChannelState {
    const key = channelId.toLowerCase();
    let state = this.channels.get(key);
    if (state === undefined) {
      state = { id: channelId, joined: false, members: new Map(), roles: new Map() };
      this.channels.set(key, state);
    }
    return state;
  }

  private dispatch(event: BotEvent): void {
    this.hostRef?.dispatch(event);
  }

  private writeLine(line: string): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) throw new Error("socket unavailable");
    const flushed = socket.write(`${line}${LINE_SEPARATOR}`, (error) => {
      if (error !== undefined && error !== null) this.lastWriteError = error.message;
    });
    if (!flushed) {
      // high-water mark reached; backpressure is bounded by the rate limiter
      // and a dead connection fails pending sends via failInFlightSends
    }
  }

  private writeLineSafe(line: string): void {
    try {
      this.writeLine(line);
    } catch {
      // protocol writes during teardown are dropped; reconnect logic owns recovery
    }
  }

  private cancelTimer(timer: ClockTimeout | null): void {
    timer?.cancel();
  }

  private reconnectOptions(): { initialDelayMs: number; maxDelayMs: number } {
    const configured = this.options.reconnect;
    return {
      initialDelayMs: configured?.initialDelayMs ?? DEFAULT_RECONNECT_OPTIONS.initialDelayMs,
      maxDelayMs: configured?.maxDelayMs ?? DEFAULT_RECONNECT_OPTIONS.maxDelayMs,
    };
  }
}

function mergeUnique(channels: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const channel of channels) {
    const key = channel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(channel);
  }
  return merged;
}

function normalizeAction(text: string): string {
  if (!text.startsWith(ACTION_MARKER)) return text;
  let body = text.slice(ACTION_MARKER.length);
  if (body.endsWith(CTCP_DELIMITER)) body = body.slice(0, -CTCP_DELIMITER.length);
  return `/me ${body}`;
}
