import * as net from "node:net";

const CRLF = "\r\n";
const DEFAULT_WAIT_MS = 5000;

export interface ClientHandle {
  readonly nick: string;
  sendLine(raw: string): void;
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  lines(): string[];
  close(): Promise<void>;
}

export interface IrcTestServer {
  readonly port: number;
  close(): Promise<void>;
  dropClient(nick: string): void;
  pingClient(nick: string): void;
  connectAs(nick: string): Promise<ClientHandle>;
  hasClient(nick: string): boolean;
  connectionCount(): number;
  linesFrom(nick: string): string[];
  waitForFrom(nick: string, pattern: RegExp, timeoutMs?: number): Promise<string>;
}

export interface IrcTestServerOptions {
  opsInChannel?: Record<string, string[]>;
}

interface LineWaiter {
  pattern: RegExp;
  resolve: (line: string) => void;
  reject: (cause: Error) => void;
  timer: NodeJS.Timeout;
}

interface ClientRecord {
  socket: net.Socket;
  buffer: string;
  nick: string | null;
  user: string | null;
  welcomed: boolean;
  channels: Set<string>;
  receivedLines: string[];
  waiters: LineWaiter[];
}

function takeCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.length > 0), rest };
}

class TestIrcServer implements IrcTestServer {
  readonly port: number;

  private readonly server: net.Server;
  private readonly clientsByNick = new Map<string, ClientRecord>();
  private readonly staging = new Set<ClientRecord>();
  private readonly opsInChannel: Record<string, string[]>;
  private totalConnections = 0;
  private pingSeq = 0;
  private closed = false;

  private constructor(server: net.Server, port: number, options: IrcTestServerOptions) {
    this.server = server;
    this.port = port;
    this.opsInChannel = options.opsInChannel ?? {};
    server.on("connection", (socket) => this.onConnection(socket));
    server.on("error", () => {});
  }

  static async start(options: IrcTestServerOptions): Promise<IrcTestServer> {
    return await new Promise<IrcTestServer>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("irc test server failed to bind"));
          return;
        }
        resolve(new TestIrcServer(server, address.port, options));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const fail = new Error("irc test server closed");
    for (const record of this.allRecords()) {
      this.failWaiters(record, fail);
      record.socket.destroy();
    }
    this.clientsByNick.clear();
    this.staging.clear();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  connectionCount(): number {
    return this.totalConnections;
  }

  hasClient(nick: string): boolean {
    return this.clientsByNick.has(nick.toLowerCase());
  }

  linesFrom(nick: string): string[] {
    return [...(this.recordFor(nick)?.receivedLines ?? [])];
  }

  async waitForFrom(nick: string, pattern: RegExp, timeoutMs: number = DEFAULT_WAIT_MS): Promise<string> {
    const record = this.requireRecord(nick);
    const existing = record.receivedLines.find((line) => pattern.test(line));
    if (existing !== undefined) return existing;
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        record.waiters = record.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`timed out waiting for ${String(pattern)} from "${nick}"`));
      }, timeoutMs);
      record.waiters.push({ pattern, resolve, reject, timer });
    });
  }

  dropClient(nick: string): void {
    const record = this.recordFor(nick);
    if (record === undefined) throw new Error(`no connected client "${nick}"`);
    record.socket.destroy();
  }

  pingClient(nick: string): void {
    const record = this.requireRecord(nick);
    this.pingSeq += 1;
    record.socket.write(`PING :test-ping-${this.pingSeq}${CRLF}`);
  }

  async connectAs(nick: string): Promise<ClientHandle> {
    const socket = net.connect({ host: "127.0.0.1", port: this.port });
    const lines: string[] = [];
    let buffer = "";
    const waiters: LineWaiter[] = [];
    const feed = (chunk: string) => {
      buffer += chunk;
      const parsed = takeCompleteLines(buffer);
      buffer = parsed.rest;
      for (const line of parsed.lines) {
        lines.push(line);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (!waiters[i]?.pattern.test(line)) continue;
          const waiter = waiters.splice(i, 1)[0];
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          waiter.resolve(line);
        }
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => feed(chunk));
    socket.on("error", () => {});
    socket.write(`NICK ${nick}${CRLF}`);
    socket.write(`USER ${nick} 0 * :${nick}${CRLF}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`raw client "${nick}" never saw 001`)), DEFAULT_WAIT_MS);
      const seen = lines.find((line) => /\b001\b/.test(line));
      if (seen !== undefined) {
        clearTimeout(timer);
        resolve();
        return;
      }
      waiters.push({
        pattern: /\b001\b/,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
        timer,
      });
    });
    return {
      nick,
      sendLine: (raw: string) => socket.write(`${raw}${CRLF}`),
      waitFor: async (pattern: RegExp, timeoutMs: number = DEFAULT_WAIT_MS) => {
        const existing = lines.find((line) => pattern.test(line));
        if (existing !== undefined) return existing;
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex((w) => w.timer === timer);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`client "${nick}" timed out waiting for ${String(pattern)}`));
          }, timeoutMs);
          waiters.push({ pattern, resolve, reject, timer });
        });
      },
      lines: () => [...lines],
      close: async () => {
        await new Promise<void>((resolve) => {
          if (socket.destroyed) {
            resolve();
            return;
          }
          socket.once("close", () => resolve());
          socket.destroy();
        });
      },
    };
  }

  private allRecords(): ClientRecord[] {
    return [...this.staging, ...this.clientsByNick.values()];
  }

  private recordFor(nick: string): ClientRecord | undefined {
    return this.clientsByNick.get(nick.toLowerCase());
  }

  private requireRecord(nick: string): ClientRecord {
    const record = this.recordFor(nick);
    if (record === undefined) throw new Error(`no connected client "${nick}"`);
    return record;
  }

  private failWaiters(record: ClientRecord, cause: Error): void {
    for (const waiter of record.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(cause);
    }
  }

  private onConnection(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.totalConnections += 1;
    const record: ClientRecord = {
      socket,
      buffer: "",
      nick: null,
      user: null,
      welcomed: false,
      channels: new Set(),
      receivedLines: [],
      waiters: [],
    };
    this.staging.add(record);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onChunk(record, chunk));
    socket.on("error", () => {});
    socket.on("close", () => this.onClose(record));
  }

  private onChunk(record: ClientRecord, chunk: string): void {
    record.buffer += chunk;
    const { lines, rest } = takeCompleteLines(record.buffer);
    record.buffer = rest;
    for (const line of lines) this.onLine(record, line);
  }

  private onLine(record: ClientRecord, line: string): void {
    record.receivedLines.push(line);
    this.resolveWaiters(record, line);
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const spaceIndex = trimmed.indexOf(" ");
    const command = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toUpperCase();
    const argumentText = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1);
    switch (command) {
      case "NICK":
        this.onNick(record, argumentText.trim());
        return;
      case "USER":
        this.onUser(record, argumentText);
        return;
      case "JOIN":
        this.onJoin(record, argumentText);
        return;
      case "PART":
        this.onPart(record, argumentText);
        return;
      case "PRIVMSG":
        this.onPrivmsg(record, line);
        return;
      case "PING":
        record.socket.write(`PONG ${argumentText}${CRLF}`);
        return;
      case "QUIT":
        this.onQuit(record, argumentText);
        return;
      default:
        return;
    }
  }

  private resolveWaiters(record: ClientRecord, line: string): void {
    const matched = record.waiters.filter((w) => w.pattern.test(line));
    for (const waiter of matched) {
      const index = record.waiters.indexOf(waiter);
      if (index >= 0) record.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  }

  private onNick(record: ClientRecord, nick: string): void {
    if (record.nick === null) this.staging.delete(record);
    if (record.nick !== null && this.clientsByNick.get(record.nick.toLowerCase()) === record) {
      this.clientsByNick.delete(record.nick.toLowerCase());
    }
    record.nick = nick;
    this.clientsByNick.set(nick.toLowerCase(), record);
    this.staging.delete(record);
    this.maybeWelcome(record);
  }

  private onUser(record: ClientRecord, argumentText: string): void {
    record.user = argumentText.split(" ")[0] ?? record.nick ?? "user";
    this.maybeWelcome(record);
  }

  private maybeWelcome(record: ClientRecord): void {
    if (record.nick === null || record.user === null || record.welcomed) return;
    record.welcomed = true;
    record.socket.write(`:irc.test 001 ${record.nick} :Welcome to the test network ${record.nick}${CRLF}`);
  }

  private onJoin(record: ClientRecord, argumentText: string): void {
    if (record.nick === null || !record.welcomed) return;
    const firstToken = argumentText.split(" ")[0] ?? "";
    for (const channel of firstToken.split(",").filter((c) => c.length > 0)) {
      record.channels.add(channel);
      const announcement = `:${record.nick}!${record.user}@127.0.0.1 JOIN ${channel}`;
      this.broadcastToChannel(channel, announcement);
      this.sendNames(record, channel);
    }
  }

  private onPart(record: ClientRecord, argumentText: string): void {
    if (record.nick === null) return;
    const channel = argumentText.split(" ")[0] ?? "";
    if (channel.length === 0 || !record.channels.has(channel)) return;
    record.channels.delete(channel);
    this.broadcastToChannel(channel, `:${record.nick}!${record.user}@127.0.0.1 PART ${channel}`);
  }

  private onPrivmsg(record: ClientRecord, rawLine: string): void {
    if (record.nick === null) return;
    const colonIndex = rawLine.indexOf(":");
    const head = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
    const argumentsText = head.trim().slice("PRIVMSG".length).trim();
    const target = argumentsText.split(" ")[0] ?? "";
    const prefixed = `:${record.nick}!${record.user}@127.0.0.1 ${rawLine}`;
    if (target.startsWith("#")) {
      this.broadcastToChannel(target, prefixed, record);
      return;
    }
    const recipient = this.recordFor(target);
    recipient?.socket.write(`${prefixed}${CRLF}`);
  }

  private onQuit(record: ClientRecord, _argumentText: string): void {
    if (record.nick === null) return;
    const farewell = `:${record.nick}!${record.user}@127.0.0.1 QUIT :Quit: leaving`;
    for (const channel of record.channels) this.broadcastToChannel(channel, farewell, record);
    record.socket.destroy();
  }

  private onClose(record: ClientRecord): void {
    this.failWaiters(record, new Error("connection closed"));
    this.staging.delete(record);
    if (record.nick !== null && this.clientsByNick.get(record.nick.toLowerCase()) === record) {
      this.clientsByNick.delete(record.nick.toLowerCase());
    }
    record.channels.clear();
  }

  private broadcastToChannel(channel: string, line: string, exclude?: ClientRecord): void {
    for (const member of this.clientsByNick.values()) {
      if (member === exclude || !member.channels.has(channel)) continue;
      member.socket.write(`${line}${CRLF}`);
    }
  }

  private sendNames(joiner: ClientRecord, channel: string): void {
    if (joiner.nick === null) return;
    const members: string[] = [];
    for (const member of this.clientsByNick.values()) {
      if (!member.channels.has(channel) || member.nick === null) continue;
      const isOp = (this.opsInChannel[channel] ?? []).includes(member.nick);
      members.push(isOp ? `@${member.nick}` : member.nick);
    }
    joiner.socket.write(`:irc.test 353 ${joiner.nick} = ${channel} :${members.join(" ")}${CRLF}`);
    joiner.socket.write(`:irc.test 366 ${joiner.nick} ${channel} :End of /NAMES list${CRLF}`);
  }
}

export async function startIrcTestServer(
  options: IrcTestServerOptions = {},
): Promise<IrcTestServer> {
  return await TestIrcServer.start(options);
}
