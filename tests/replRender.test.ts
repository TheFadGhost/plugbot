import { describe, expect, it } from "vitest";

import { PROMPT, renderDelivery, renderSystemNotice } from "../src/cli/replRender.js";
import type { MockDelivery } from "../src/adapter/mock.js";
import { resetCode } from "../src/logging/themes.js";

const OFF = { theme: "dark" as const, color: false };
const ON_DARK = { theme: "dark" as const, color: true };

function send(overrides: Partial<Extract<MockDelivery, { kind: "send" }>> = {}): MockDelivery {
  return {
    kind: "send",
    channelId: "general",
    messageId: "m000001",
    text: "pong",
    seq: 1,
    ...overrides,
  };
}

describe("renderDelivery", () => {
  it("renders sends as [#channel] plugbot: text", () => {
    expect(renderDelivery(send(), OFF)).toEqual(["[#general] plugbot: pong"]);
  });

  it("appends a thread suffix when threadId is present", () => {
    const lines = renderDelivery(send({ threadId: "t-1", text: "in thread" }), OFF);
    expect(lines).toEqual(["[#general] plugbot: in thread (thread)"]);
  });

  it("renders reactions as reacted [#channel] :emoji:", () => {
    const lines = renderDelivery(
      { kind: "react", channelId: "general", messageId: "m000002", emoji: "tada", seq: 2 },
      OFF,
    );
    expect(lines).toEqual(["reacted [#general] :tada:"]);
  });

  it("renders edits as edited [#channel] id: text", () => {
    const lines = renderDelivery(
      { kind: "edit", channelId: "general", messageId: "m000003", text: "new text", seq: 3 },
      OFF,
    );
    expect(lines).toEqual(["edited [#general] m000003: new text"]);
  });

  it("renders deletions as deleted [#channel] id", () => {
    const lines = renderDelivery(
      { kind: "delete", channelId: "random", messageId: "m000004", seq: 4 },
      OFF,
    );
    expect(lines).toEqual(["deleted [#random] m000004"]);
  });

  it("ignores typing start and stop deliveries", () => {
    expect(renderDelivery({ kind: "typingStart", channelId: "general", seq: 5 }, OFF)).toEqual([]);
    expect(renderDelivery({ kind: "typingStop", channelId: "general", seq: 6 }, OFF)).toEqual([]);
  });

  it("produces zero escape sequences with colour off", () => {
    const all: MockDelivery[] = [
      send(),
      send({ threadId: "t" }),
      { kind: "react", channelId: "general", messageId: "m", emoji: "tada", seq: 2 },
      { kind: "edit", channelId: "general", messageId: "m", text: "t", seq: 3 },
      { kind: "delete", channelId: "general", messageId: "m", seq: 4 },
    ];
    for (const delivery of all) {
      for (const line of renderDelivery(delivery, OFF)) {
        expect(line.includes("\u001B")).toBe(false);
      }
    }
  });

  it("wraps only channel and name segments when colour is on", () => {
    const [line] = renderDelivery(send(), ON_DARK);
    expect(line).toBeDefined();
    if (line === undefined) return;
    expect(line.startsWith("\u001B[90m[#")).toBe(true);
    expect(line.endsWith("pong")).toBe(true);
    expect(line.endsWith(resetCode)).toBe(false);
    const fgRefCount = line.split("\u001B[90m").length - 1;
    const resetCount = line.split(resetCode).length - 1;
    expect(fgRefCount).toBeGreaterThanOrEqual(2);
    expect(resetCount).toBe(fgRefCount);
  });
});

describe("repl constants", () => {
  it("exposes the plain prompt and system notice prefix", () => {
    expect(PROMPT).toBe("you> ");
    expect(renderSystemNotice("hot reload on")).toBe("note: hot reload on");
    expect(renderSystemNotice("x").includes("\u001B")).toBe(false);
  });
});
