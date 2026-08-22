/** Platform-neutral message and event types shared by adapters, router, plugins. */

export interface User {
  id: string;
  username: string;
  displayName?: string;
  isBot?: boolean;
}

export type ChannelKind = "channel" | "group" | "dm";

export interface Channel {
  id: string;
  name?: string;
  kind: ChannelKind;
}

/** Reference to a message that exists (or existed) on a platform. */
export interface MessageRef {
  channelId: string;
  messageId: string;
  threadId?: string;
}

export interface SendOptions {
  threadId?: string;
}

export interface Message {
  /** Platform message id, unique within the adapter. */
  id: string;
  text: string;
  author: User;
  channelId: string;
  threadId?: string;
  createdAt: number;
  /** User ids explicitly mentioned in the message. */
  mentions: string[];
}

export interface SentMessageRef extends MessageRef {}

export const EVENT_TYPES = ["message", "memberJoin", "memberLeave"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface MessageEvent {
  type: "message";
  at: number;
  message: Message;
}

export interface MemberJoinEvent {
  type: "memberJoin";
  at: number;
  userId: string;
  channelId: string;
}

export interface MemberLeaveEvent {
  type: "memberLeave";
  at: number;
  userId: string;
  channelId: string;
}

export type BotEvent = MessageEvent | MemberJoinEvent | MemberLeaveEvent;

/** Roles are plain strings; "admin" has framework meaning for admin commands. */
export type Role = string;
