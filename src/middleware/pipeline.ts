import type { Middleware, NextFn } from "../plugin/types.js";
import type { Message } from "../types.js";

export interface DispatchTrace {
  terminalReached: boolean;
}

const dispatchTraces = new WeakMap<Message, DispatchTrace>();

export function dispatchTraceFor(message: Message): DispatchTrace | undefined {
  return dispatchTraces.get(message);
}

export function composePipeline(
  middleware: readonly Middleware[],
): (message: Message, terminal: NextFn) => Promise<void> {
  return async (message, terminal) => {
    const trace: DispatchTrace = { terminalReached: false };
    dispatchTraces.set(message, trace);
    const terminalStep: NextFn = async () => {
      trace.terminalReached = true;
      await terminal();
    };
    const descend = (index: number): Promise<void> => {
      const step = middleware[index];
      if (step === undefined) return terminalStep();
      return Promise.resolve(step(message, () => descend(index + 1)));
    };
    await descend(0);
  };
}

export function executePipeline(
  middleware: readonly Middleware[],
  message: Message,
  terminal: NextFn,
): Promise<void> {
  return composePipeline(middleware)(message, terminal);
}
