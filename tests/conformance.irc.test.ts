import { afterEach, beforeEach, describe } from "vitest";
import { IrcAdapter } from "../src/adapter/irc/ircAdapter.js";
import { describeAdapterConformance } from "../src/testing/conformance.js";
import { startIrcTestServer } from "../src/testing/ircServer.js";
import type { IrcTestServer } from "../src/testing/ircServer.js";

describe("conformance.irc", () => {
  let server: IrcTestServer;

  beforeEach(async () => {
    server = await startIrcTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  describeAdapterConformance(
    "irc",
    () =>
      new IrcAdapter({
        server: "127.0.0.1",
        port: server.port,
        nick: `conf-${Math.random().toString(36).slice(2, 8)}`,
        autoJoin: ["#conf"],
        reconnect: { initialDelayMs: 50, maxDelayMs: 500 },
        outboundRateLimit: { messagesPerSecond: 50, burst: 20 },
      }),
    { channels: ["#conf"], timeoutMs: 4000 },
  );
});
