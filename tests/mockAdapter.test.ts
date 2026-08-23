import { describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapter/mock.js";
import type { AdapterHost } from "../src/adapter/adapter.js";
import type { MockDelivery, SimulateMessageInput } from "../src/adapter/mock.js";
import { AdapterOperationError } from "../src/errors.js";
import type {
  BotEvent,
  MemberJoinEvent,
  MemberLeaveEvent,
  MessageEvent,
} from "../src/types.js";

function captureHost(): { host: AdapterHost; events: BotEvent[] } {
  const events: BotEvent[] = [];
  return {
    events,
    host: {
      dispatch(event: BotEvent): void {
        events.push(event);
      },
    },
  };
}

function requireEvent<T extends BotEvent>(events: BotEvent[], index: number, type: T["type"]): T {
  const event = events[index];
  if (event === undefined || event.type !== type) {
    throw new Error(`expected ${String(type)} event at index ${index}, got ${String(event?.type)}`);
  }
  return event as T;
}

describe("MockAdapter", () => {
  it("records send, edit, react and delete deliveries with increasing seq", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    const sent = await adapter.send("general", "hello world");
    expect(sent).toEqual({ channelId: "general", messageId: "m000001" });
    expect(adapter.history("general").map((message) => message.text)).toEqual(["hello world"]);

    const ref = { channelId: sent.channelId, messageId: sent.messageId };
    await adapter.editMessage(ref, "hello edited");
    expect(adapter.history("general")[0]?.text).toBe("hello edited");

    await adapter.react(ref, "eyes");
    expect([...adapter.reactionsOf("m000001")]).toEqual(["eyes"]);

    await adapter.deleteMessage(ref);
    expect(adapter.history("general")).toEqual([]);
    expect([...adapter.reactionsOf("m000001")]).toEqual([]);

    const deliveries: readonly MockDelivery[] = adapter.deliveries();
    expect(deliveries.map((delivery) => delivery.kind)).toEqual(["send", "edit", "react", "delete"]);
    expect(deliveries.map((delivery) => delivery.seq)).toEqual([1, 2, 3, 4]);
    expect(deliveries[0]).toEqual({
      kind: "send",
      channelId: "general",
      messageId: "m000001",
      text: "hello world",
      seq: 1,
    });
  });

  it("records threaded sends with the thread id on ref, history and delivery", async () => {
    const adapter = new MockAdapter();
    const sent = await adapter.send("random", "thread reply", { threadId: "t9" });
    expect(sent.threadId).toBe("t9");
    expect(adapter.history("random")[0]?.threadId).toBe("t9");
    expect(adapter.deliveries()[0]).toEqual({
      kind: "send",
      channelId: "random",
      messageId: "m000001",
      threadId: "t9",
      text: "thread reply",
      seq: 1,
    });
  });

  it("rejects unknown channels for send, typing and simulateMessage", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    await expect(adapter.send("ghost", "x")).rejects.toBeInstanceOf(AdapterOperationError);
    await expect(adapter.send("ghost", "x")).rejects.toThrow(/unknown channel/);
    await expect(adapter.startTyping("ghost")).rejects.toBeInstanceOf(AdapterOperationError);
    expect(() => adapter.simulateMessage({ channelId: "ghost", text: "x" })).toThrow(AdapterOperationError);

    const failure = (await adapter.send("ghost", "x").then(
      () => {
        throw new Error("expected rejection");
      },
      (cause: unknown) => cause as AdapterOperationError,
    )) as AdapterOperationError;
    expect(failure.code).toBe("ADAPTER_OPERATION_FAILED");
    expect(failure.fields.operation).toBe("send");
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("dispatches simulated messages to the host with parsed mentions", async () => {
    const { host, events } = captureHost();
    const adapter = new MockAdapter();
    await adapter.start(host);

    const input: SimulateMessageInput = {
      userId: "u-alice",
      channelId: "general",
      text: "hey @bob and @bob plus @ghost but bare bob stays quiet",
    };
    const message = adapter.simulateMessage(input);

    expect(message.id).toBe("m000001");
    expect(message.author).toEqual({ id: "u-alice", username: "alice" });
    expect(message.mentions).toEqual(["u-bob"]);
    expect(message.createdAt).toBeTypeOf("number");

    const event = requireEvent<MessageEvent>(events, 0, "message");
    expect(event.at).toBe(message.createdAt);
    expect(event.message).toEqual(message);
    expect(adapter.history("general")).toEqual([message]);
    expect(adapter.deliveries()).toEqual([]);
  });

  it("synthesizes users for unknown identities referenced by simulation", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    const byUsername = adapter.simulateMessage({ username: "dana", channelId: "general", text: "hi" });
    expect(byUsername.author).toEqual({ id: "u-dana", username: "dana" });
    expect(await adapter.getUser("u-dana")).toEqual({ id: "u-dana", username: "dana" });

    const byUserId = adapter.simulateMessage({ userId: "z9", channelId: "general", text: "hi" });
    expect(byUserId.author).toEqual({ id: "z9", username: "z9" });
  });

  it("shares one message id sequence between send and simulateMessage", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    const simulated = adapter.simulateMessage({ userId: "u-alice", channelId: "general", text: "first" });
    const sent = await adapter.send("general", "second");

    expect(simulated.id).toBe("m000001");
    expect(sent.messageId).toBe("m000002");
  });

  it("dispatches member joins and leaves through the host", () => {
    const { host, events } = captureHost();
    const adapter = new MockAdapter();
    adapter.start(host);

    adapter.simulateJoin("u-carol", "random");
    adapter.simulateLeave("u-bob", "general");

    const joined = requireEvent<MemberJoinEvent>(events, 0, "memberJoin");
    expect(joined.userId).toBe("u-carol");
    expect(joined.channelId).toBe("random");

    const left = requireEvent<MemberLeaveEvent>(events, 1, "memberLeave");
    expect(left.userId).toBe("u-bob");
    expect(left.channelId).toBe("general");
  });

  it("resolves configured roles, honours setRoles and copies role values", async () => {
    const configuredRoles: Record<string, string[]> = { "u-bob": ["admin"] };
    const adapter = new MockAdapter({ roles: configuredRoles });
    configuredRoles["u-carol"] = ["leaked"];

    expect(await adapter.resolveRoles("u-bob")).toEqual(["admin"]);
    expect(await adapter.resolveRoles("u-carol")).toEqual([]);
    expect(await adapter.resolveRoles("u-nobody")).toEqual([]);

    adapter.setRoles("u-carol", ["moderator"]);
    expect(await adapter.resolveRoles("u-carol")).toEqual(["moderator"]);

    const snapshot = [...(await adapter.resolveRoles("u-carol"))];
    snapshot.length = 0;
    expect(await adapter.resolveRoles("u-carol")).toEqual(["moderator"]);

    adapter.setRoles("u-bob", []);
    expect(await adapter.resolveRoles("u-bob")).toEqual([]);
  });

  it("records typing start and stop through the returned typing handle", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    const typing = await adapter.startTyping("random");
    expect(adapter.deliveries()).toEqual([{ kind: "typingStart", channelId: "random", seq: 1 }]);

    await typing.stop();
    expect(adapter.deliveries()).toEqual([
      { kind: "typingStart", channelId: "random", seq: 1 },
      { kind: "typingStop", channelId: "random", seq: 2 },
    ]);
  });

  it("returns null lookups for absent users and channels", async () => {
    const adapter = new MockAdapter();
    await adapter.start(captureHost().host);

    expect(await adapter.getUser("u-nobody")).toBeNull();
    expect(await adapter.getChannel("nope")).toBeNull();
    expect(await adapter.getChannel("general")).toEqual({ id: "general", name: "general", kind: "channel" });
    expect(await adapter.getUser("u-plugbot")).toEqual({ id: "u-plugbot", username: "plugbot", isBot: true });
  });

  it("honours custom channels and users from options alongside defaults", async () => {
    const adapter = new MockAdapter({
      channels: [{ id: "ops", name: "operations" }],
      users: [{ id: "u-zoe", username: "zoe", displayName: "Zoe" }],
    });

    expect(await adapter.getChannel("ops")).toEqual({ id: "ops", name: "operations", kind: "channel" });
    expect(await adapter.getUser("u-zoe")).toEqual({ id: "u-zoe", username: "zoe", displayName: "Zoe" });
    expect(await adapter.getChannel("general")).not.toBeNull();
    await expect(adapter.send("ops", "hi")).resolves.toMatchObject({ messageId: "m000001" });
  });

  it("clears deliveries without resetting the seq counter", async () => {
    const adapter = new MockAdapter();
    await adapter.send("general", "one");
    adapter.clearDeliveries();
    expect(adapter.deliveries()).toEqual([]);
    await adapter.send("general", "two");
    expect(adapter.deliveries().map((delivery) => [delivery.kind, delivery.seq])).toEqual([["send", 2]]);
  });
});
