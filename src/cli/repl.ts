import type { Interface } from "node:readline";
import { createInterface } from "node:readline/promises";

import type { MockAdapter, MockDelivery } from "../adapter/mock.js";
import { decideColour } from "../logging/logger.js";
import { applyTheme, type ThemeName } from "../logging/themes.js";
import type { RunningBot } from "../runtime/types.js";
import { PROMPT, renderDelivery } from "./replRender.js";

export interface ReplStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface ReplDependencies {
  bot: RunningBot;
  mock: MockAdapter;
  streams: ReplStreams;
  env: Record<string, string | undefined>;
  theme?: ThemeName;
  prefix?: string;
}

const READY_LINE = "mock adapter ready. try !help";
const FRAME_MS = 10;
const QUIET_FRAMES = 2;
const WAIT_CAP_MS = 2000;
const CTRL_C_EXIT_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function maxSeq(deliveries: readonly MockDelivery[]): number {
  let highest = 0;
  for (const delivery of deliveries) {
    if (delivery.seq > highest) highest = delivery.seq;
  }
  return highest;
}

async function waitForQuiet(mock: MockAdapter): Promise<void> {
  const deadline = Date.now() + WAIT_CAP_MS;
  let observedSeq = maxSeq(mock.deliveries());
  let stableFrames = 0;
  while (stableFrames < QUIET_FRAMES && Date.now() < deadline) {
    await delay(FRAME_MS);
    const seq = maxSeq(mock.deliveries());
    if (seq === observedSeq) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
      observedSeq = seq;
    }
  }
}

function historyOf(rl: Interface): string[] {
  return (rl as unknown as { history: string[] }).history;
}

function pruneEmptyHistory(rl: Interface): void {
  const history = historyOf(rl);
  const kept = history.filter((entry: string) => entry.trim() !== "");
  if (kept.length !== history.length) {
    history.splice(0, history.length, ...kept);
  }
}

function errorLine(reason: string, nextStep: string, theme: ThemeName, colour: boolean): string {
  return applyTheme("levelError", `error: ${reason} - ${nextStep}`, colour, theme);
}

export async function runRepl(deps: ReplDependencies): Promise<void> {
  const stdout = deps.streams.stdout;
  const theme: ThemeName = deps.theme ?? "dark";
  const prefix = deps.prefix ?? "!";
  const colourAllowed = decideColour(
    deps.streams.stdout as unknown as { write(s: string): void },
    undefined,
    deps.env,
  );
  const promptText = applyTheme("fgPrompt", PROMPT, colourAllowed, theme);
  const terminal = (deps.streams.stdout as { isTTY?: unknown }).isTTY === true;

  const topLevelNames = (): string[] =>
    [...deps.bot.commandNames()]
      .filter((name) => !name.includes(" "))
      .sort();

  stdout.write(`${READY_LINE}\n\n`);

  const rl = createInterface({
    input: deps.streams.stdin,
    output: deps.streams.stdout,
    prompt: promptText,
    terminal,
    completer: () => [[], ""] as [string[], string],
  });

  const prompt = (): void => {
    rl.prompt();
  };

  let printedSeq = 0;

  const printNewDeliveries = (): void => {
    for (const delivery of deps.mock.deliveries()) {
      if (delivery.seq <= printedSeq) continue;
      printedSeq = Math.max(printedSeq, delivery.seq);
      for (const line of renderDelivery(delivery, { theme, color: colourAllowed })) {
        stdout.write(`${line}\n`);
      }
    }
  };

  const submit = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line === "") {
      prompt();
      return;
    }
    try {
      deps.mock.simulateMessage({ username: "alice", channelId: "general", text: line });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      stdout.write(`${errorLine(reason, "check the input and try again", theme, colourAllowed)}\n`);
      prompt();
      return;
    }
    await waitForQuiet(deps.mock);
    printNewDeliveries();
    stdout.write("\n");
    prompt();
  };

  let lastCtrlCAt = 0;
  const pendingSubmissions = new Set<Promise<void>>();

  rl.on("line", (raw: string) => {
    pruneEmptyHistory(rl);
    const submission = submit(raw).finally(() => {
      pendingSubmissions.delete(submission);
    });
    pendingSubmissions.add(submission);
  });

  rl.on("keypress", (_character: unknown, key: { name?: string } | undefined) => {
    if (key?.name !== "tab") return;
    const line = rl.line;
    if (line.includes(" ")) return;
    const token = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const matches = topLevelNames().filter((name) => name.startsWith(token));
    if (matches.length === 1) {
      const completed = matches[0] !== undefined ? prefix + matches[0] + " " : "";
      (rl as unknown as { line: string }).line = "";
      rl.write(completed);
      return;
    }
    if (matches.length > 1) {
      stdout.write(`\n${matches.join("  ")}\n`);
      prompt();
    }
  });

  rl.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastCtrlCAt <= CTRL_C_EXIT_MS) {
      rl.close();
      return;
    }
    lastCtrlCAt = now;
    rl.write(null, { ctrl: true, name: "u" });
    prompt();
  });

  await new Promise<void>((resolveClosed) => {
    rl.on("close", () => {
      void Promise.allSettled([...pendingSubmissions]).then(() => resolveClosed());
    });
  });
}
