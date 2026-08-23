/**
 * The shared PluginRuntime surface implemented by both isolation modes
 * (worker thread bridge and in-process inline execution). See DESIGN.md
 * section 8.
 */

import type { Message } from "../types.js";
import type { CircuitBreaker } from "./breaker.js";
import type { PluginIsolation, PluginManifest } from "./manifest.js";

export interface RuntimeLimits {
  handlerTimeoutMs: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
}

export interface ShutdownResult {
  drained: boolean;
}

export type RuntimeEventName = "message" | "memberJoin" | "memberLeave";

export interface PluginRuntime {
  readonly name: string;
  readonly manifest: PluginManifest;
  readonly isolation: PluginIsolation;
  readonly breaker: CircuitBreaker;
  init(): Promise<void>;
  invokeCommand(
    path: string[],
    message: Message,
    args: Record<string, unknown>,
    rawArgs: string[],
  ): Promise<void>;
  invokeListener(name: string, message: Message, match: RegExpMatchArray | null): Promise<void>;
  invokeEvent(name: RuntimeEventName, payload: unknown): Promise<void>;
  invokeJob(name: string, scheduledFor: number): Promise<void>;
  shutdown(graceMs: number): Promise<ShutdownResult>;
  dispose(): Promise<void>;
}
