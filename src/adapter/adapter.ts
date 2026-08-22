/**
 * Adapter contracts. An adapter abstracts one chat platform. See DESIGN.md
 * sections 8 (capability matrix) and 11 for the committed behaviour.
 */

import type { Clock } from "../clock.js";
import { CapabilityError } from "../errors.js";
import type {
  BotEvent,
  Channel,
  Message,
  MessageRef,
  Role,
  SendOptions,
  SentMessageRef,
  User,
} from "../types.js";

export interface Capabilities {
  readonly send: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
  readonly react: boolean;
  readonly threads: boolean;
  readonly typing: boolean;
  readonly memberEvents: boolean;
  readonly userLookup: boolean;
  readonly channelLookup: boolean;
  /** Whether resolveRoles can produce meaningful answers on this platform. */
  readonly roles: boolean;
}

export interface TypingHandle {
  stop(): Promise<void>;
}

/** The framework side of the adapter boundary; adapters call dispatch(). */
export interface AdapterHost {
  dispatch(event: BotEvent): void;
}

export interface AdapterStartOptions {
  /** Channels to join at startup where the platform supports joining. */
  readonly autoJoin?: readonly string[];
}

export interface Adapter {
  readonly name: string;
  readonly capabilities: Capabilities;

  start(host: AdapterHost, options?: AdapterStartOptions): Promise<void>;
  stop(): Promise<void>;

  send(channelId: string, text: string, options?: SendOptions): Promise<SentMessageRef>;
  editMessage(ref: MessageRef, text: string): Promise<void>;
  deleteMessage(ref: MessageRef): Promise<void>;
  react(ref: MessageRef, emoji: string): Promise<void>;
  startTyping(channelId: string): Promise<TypingHandle>;
  getUser(userId: string): Promise<User | null>;
  getChannel(channelId: string): Promise<Channel | null>;
  resolveRoles(userId: string, channelId?: string): Promise<readonly Role[]>;
}

/**
 * Base class implementing every optional operation as a loud capability
 * failure. Concrete adapters override exactly what they support; nothing
 * silently does nothing.
 */
export abstract class BaseAdapter implements Adapter {
  abstract readonly name: string;
  abstract readonly capabilities: Capabilities;

  async start(_host: AdapterHost, _options?: AdapterStartOptions): Promise<void> {}
  async stop(): Promise<void> {}

  abstract send(
    channelId: string,
    text: string,
    options?: SendOptions,
  ): Promise<SentMessageRef>;

  async editMessage(_ref: MessageRef, _text: string): Promise<void> {
    this.unsupported("edit");
  }

  async deleteMessage(_ref: MessageRef): Promise<void> {
    this.unsupported("delete");
  }

  async react(_ref: MessageRef, _emoji: string): Promise<void> {
    this.unsupported("react");
  }

  async startTyping(_channelId: string): Promise<TypingHandle> {
    this.unsupported("typing");
    throw new Error("unreachable"); // satisfies control flow analysis
  }

  async getUser(_userId: string): Promise<User | null> {
    this.unsupported("user lookup");
    throw new Error("unreachable");
  }

  async getChannel(_channelId: string): Promise<Channel | null> {
    this.unsupported("channel lookup");
    throw new Error("unreachable");
  }

  async resolveRoles(_userId: string, _channelId?: string): Promise<readonly Role[]> {
    this.unsupported("role resolution");
    throw new Error("unreachable");
  }

  protected unsupported(operation: string): never {
    throw new CapabilityError(this.name, operation);
  }
}
