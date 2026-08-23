import { describe, expect, it } from "vitest";
import type { Adapter, AdapterHost } from "../adapter/adapter.js";
import type { Capabilities } from "../adapter/adapter.js";
import { AdapterOperationError, CapabilityError } from "../errors.js";
import type { ChannelKind } from "../types.js";

export interface ConformanceOptions {
  channels?: string[];
  timeoutMs?: number;
}

export interface ConformanceReport {
  adapter: string;
  checks: number;
  failures: string[];
}

const UNKNOWN_CHANNEL = "definitely-missing-channel";
const CHANNEL_KINDS: readonly ChannelKind[] = ["channel", "group", "dm"];

const noopHost: AdapterHost = { dispatch: () => {} };

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectGuard) => {
        timer = setTimeout(() => rejectGuard(new Error(`exceeded ${timeoutMs}ms guard`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

interface GuardedProbe {
  flag: boolean;
  label: string;
  operation: string;
  run: () => Promise<unknown>;
  nullable: boolean;
}

function buildProbes(adapter: Adapter, primaryChannel: string): GuardedProbe[] {
  const capabilities: Capabilities = adapter.capabilities;
  return [
    {
      flag: capabilities.edit,
      label: "edit",
      operation: "editMessage",
      nullable: false,
      run: () => adapter.editMessage({ channelId: primaryChannel, messageId: "conformance-probe" }, "edited"),
    },
    {
      flag: capabilities.delete,
      label: "delete",
      operation: "deleteMessage",
      nullable: false,
      run: () => adapter.deleteMessage({ channelId: primaryChannel, messageId: "conformance-probe" }),
    },
    {
      flag: capabilities.react,
      label: "react",
      operation: "react",
      nullable: false,
      run: () => adapter.react({ channelId: primaryChannel, messageId: "conformance-probe" }, "+1"),
    },
    {
      flag: capabilities.typing,
      label: "typing",
      operation: "startTyping",
      nullable: false,
      run: async () => {
        const handle = await adapter.startTyping(primaryChannel);
        await handle.stop();
      },
    },
    {
      flag: capabilities.userLookup,
      label: "user lookup",
      operation: "getUser",
      nullable: true,
      run: () => adapter.getUser("conformance-ghost-user"),
    },
    {
      flag: capabilities.channelLookup,
      label: "channel lookup",
      operation: "getChannel",
      nullable: true,
      run: () => adapter.getChannel(UNKNOWN_CHANNEL),
    },
    {
      flag: capabilities.roles,
      label: "role resolution",
      operation: "resolveRoles",
      nullable: false,
      run: () => adapter.resolveRoles("conformance-ghost-user", primaryChannel),
    },
  ];
}

function userShapeProblem(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "object") return `expected User object or null, got ${typeof value}`;
  const candidate = value as Partial<{ id: unknown; username: unknown }>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return "User.id missing or empty";
  if (typeof candidate.username !== "string") return "User.username missing";
  return null;
}

function channelShapeProblem(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "object") return `expected Channel object or null, got ${typeof value}`;
  const candidate = value as Partial<{ id: unknown; kind: unknown }>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return "Channel.id missing or empty";
  const kind = candidate.kind;
  if (typeof kind !== "string" || !CHANNEL_KINDS.includes(kind as ChannelKind)) {
    return `Channel.kind ${JSON.stringify(kind)} outside enum`;
  }
  return null;
}

export async function runAdapterConformance(
  factory: () => Adapter | Promise<Adapter>,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const channels = options.channels ?? ["general"];
  const guard = options.timeoutMs ?? 4000;
  const primaryChannel = channels[0] ?? "general";
  const adapter = await factory();
  const failures: string[] = [];
  let checks = 0;

  const add = (checkName: string, detail: string): void => {
    failures.push(`${checkName}: ${detail}`);
  };

  checks += 1;
  if (typeof adapter.name !== "string" || adapter.name.length === 0) {
    add("identity", "adapter.name must be a non-empty string");
  }
  if (adapter.capabilities === undefined || adapter.capabilities === null || typeof adapter.capabilities !== "object") {
    add("identity", "capabilities object missing");
  }

  checks += 1;
  try {
    await deadline(adapter.start(noopHost), guard);
  } catch (cause) {
    add("lifecycle", `first start rejected: ${describeCause(cause)}`);
  }

  checks += 1;
  for (const probe of buildProbes(adapter, primaryChannel)) {
    let outcome: unknown;
    let failure: unknown = null;
    try {
      outcome = await deadline(probe.run(), guard);
    } catch (cause) {
      failure = cause;
    }
    if (!probe.flag) {
      if (failure === null) {
        add("matrix-truth", `${probe.operation} resolved although its capability flag is false`);
        continue;
      }
      if (!(failure instanceof CapabilityError)) {
        add("matrix-truth", `${probe.operation} must reject CapabilityError when unsupported, got ${describeCause(failure)}`);
        continue;
      }
      const fields = failure.fields as { adapter?: unknown };
      if (fields.adapter !== adapter.name) {
        add("matrix-truth", `CapabilityError.fields.adapter is ${JSON.stringify(fields.adapter)}, expected "${adapter.name}"`);
        continue;
      }
      if (!failure.message.includes(probe.label) && !failure.message.includes(probe.operation)) {
        add("matrix-truth", `rejection message mentions neither "${probe.label}" nor "${probe.operation}": ${failure.message}`);
      }
      continue;
    }
    if (failure !== null) {
      if (failure instanceof CapabilityError) {
        add("matrix-truth", `${probe.operation} declared supported yet raised CapabilityError: ${describeCause(failure)}`);
      } else if (!(failure instanceof AdapterOperationError)) {
        add("matrix-truth", `${probe.operation} declared supported but failed with ${describeCause(failure)}`);
      }
      continue;
    }
    if (!probe.nullable) continue;
    const shapeProblem =
      probe.operation === "getUser" ? userShapeProblem(outcome) : channelShapeProblem(outcome);
    if (shapeProblem !== null) add("matrix-truth", `${probe.operation}: ${shapeProblem}`);
  }

  checks += 1;
  if (adapter.capabilities.userLookup) {
    try {
      const ghostUser = await deadline(adapter.getUser("conformance-unknown-user"), guard);
      const problem = userShapeProblem(ghostUser);
      if (problem !== null) add("lookup-shape", `getUser: ${problem}`);
    } catch (cause) {
      add("lookup-shape", `getUser rejected although caps.userLookup is true: ${describeCause(cause)}`);
    }
  }
  if (!adapter.capabilities.channelLookup) {
    add("lookup-shape", "getChannel probes skipped: caps.channelLookup is false");
  } else {
    for (const channelId of [UNKNOWN_CHANNEL, primaryChannel]) {
      try {
        const found = await deadline(adapter.getChannel(channelId), guard);
        const problem = channelShapeProblem(found);
        if (problem !== null) add("lookup-shape", `getChannel("${channelId}"): ${problem}`);
      } catch (cause) {
        add("lookup-shape", `getChannel("${channelId}") rejected: ${describeCause(cause)}`);
      }
    }
  }

  checks += 1;
  try {
    const ref = await deadline(adapter.send(primaryChannel, "conformance ping"), guard);
    if (typeof ref.messageId !== "string" || ref.messageId.length === 0) {
      add("send-contract", `messageId empty for send to "${primaryChannel}"`);
    }
    if (ref.channelId !== primaryChannel) {
      add("send-contract", `channelId mismatch: sent to "${primaryChannel}", ref says "${ref.channelId}"`);
    }
  } catch (cause) {
    add("send-contract", `send to "${primaryChannel}" rejected: ${describeCause(cause)}`);
  }
  let ghostModelled = false;
  try {
    const ghostRef = await deadline(adapter.send(UNKNOWN_CHANNEL, "conformance ping"), guard);
    if (typeof ghostRef.messageId !== "string" || ghostRef.messageId.length === 0) {
      add("send-contract", `send to unknown channel "${UNKNOWN_CHANNEL}" returned an empty messageId`);
    }
    const modelled = await deadline(adapter.getChannel(UNKNOWN_CHANNEL), guard);
    ghostModelled = modelled !== null && typeof modelled === "object" && modelled.id === UNKNOWN_CHANNEL;
    if (!ghostModelled) {
      add(
        "send-contract",
        `send to unknown channel "${UNKNOWN_CHANNEL}" succeeded but the channel is absent from the model afterwards`,
      );
    }
  } catch (cause) {
    if (!(cause instanceof AdapterOperationError)) {
      add(
        "send-contract",
        `send to unknown channel "${UNKNOWN_CHANNEL}" must reject AdapterOperationError, got ${describeCause(cause)}`,
      );
    } else if (cause.code !== "ADAPTER_OPERATION_FAILED") {
      add("send-contract", `unknown-channel rejection carries code ${String(cause.code)}`);
    } else if (ghostModelled) {
      add("send-contract", "unknown channel both modelled and rejected");
    }
  }

  checks += 1;
  if (!adapter.capabilities.threads) {
    try {
      await deadline(adapter.send(primaryChannel, "conformance ping", { threadId: "conformance-thread" }), guard);
      add("threads-honesty", "threaded send accepted although caps.threads is false");
    } catch (cause) {
      if (!(cause instanceof CapabilityError)) {
        add("threads-honesty", `threaded send must reject CapabilityError, got ${describeCause(cause)}`);
      }
    }
  } else {
    try {
      const threadedRef = await deadline(
        adapter.send(primaryChannel, "conformance ping", { threadId: "conformance-thread" }),
        guard,
      );
      if (typeof threadedRef.messageId !== "string" || threadedRef.messageId.length === 0) {
        add("threads-honesty", "threaded send returned an empty messageId");
      }
    } catch (cause) {
      add("threads-honesty", `threaded send rejected although caps.threads is true: ${describeCause(cause)}`);
    }
  }

  checks += 1;
  if (adapter.capabilities.roles) {
    try {
      const roles = await deadline(adapter.resolveRoles("conformance-ghost-user", primaryChannel), guard);
      if (!Array.isArray(roles)) {
        add("roles-shape", `resolveRoles resolved ${typeof roles}, expected an array`);
      } else if (!roles.every((role) => typeof role === "string")) {
        add("roles-shape", "resolveRoles produced a non-string entry");
      }
    } catch (cause) {
      add("roles-shape", `resolveRoles rejected although caps.roles is true: ${describeCause(cause)}`);
    }
  }

  checks += 1;
  try {
    const first = await deadline(adapter.send(primaryChannel, "conformance ids one"), guard);
    const second = await deadline(adapter.send(primaryChannel, "conformance ids two"), guard);
    if (first.messageId === second.messageId) {
      add("determinism-of-ids", "two consecutive sends produced identical messageIds");
    }
  } catch (cause) {
    add("determinism-of-ids", `id probe sends failed: ${describeCause(cause)}`);
  }

  checks += 1;
  try {
    await deadline(adapter.start(noopHost), guard);
  } catch (restartCause) {
    const loudRefusal =
      restartCause instanceof AdapterOperationError &&
      (restartCause.fields as { operation?: unknown }).operation === "start";
    if (!loudRefusal) {
      add("lifecycle", `second start neither resolved nor refused loudly: ${describeCause(restartCause)}`);
    }
  }

  checks += 1;
  try {
    await deadline(adapter.stop(), guard);
    await deadline(adapter.stop(), guard);
  } catch (cause) {
    add("lifecycle", `stop sequence failed: ${describeCause(cause)}`);
  }

  return { adapter: adapter.name, checks, failures };
}

export function describeAdapterConformance(
  suiteName: string,
  factory: () => Adapter | Promise<Adapter>,
  options?: ConformanceOptions,
): void {
  describe(`adapter conformance: ${suiteName}`, () => {
    it("passes every conformance check", async () => {
      const report = await runAdapterConformance(factory, options);
      const dump = report.failures.map((failure) => `\n  - ${failure}`).join("");
      expect(
        report.failures,
        `${suiteName} adapter failed ${report.failures.length}/${report.checks} conformance checks${dump}`,
      ).toEqual([]);
    }, Math.max((options?.timeoutMs ?? 4000) * 6, 20_000));
  });
}
