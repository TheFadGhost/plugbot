import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const lines = [
  "!help",
  "!remind 1h tea",
  '!poll start "lunch?" ramen salad',
  "!poll vote 1",
  "!mystats",
  "exit",
];

const child = spawn(
  process.execPath,
  ["--import", "tsx", "src/cli/main.ts", "dev", "--config", "data/dev-config.json"],
  { env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] },
);

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  output += chunk;
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
  output += chunk;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(800);
  for (const line of lines) {
    child.stdin.write(`${line}\n`);
    await sleep(1400);
  }
  await sleep(600);
  child.kill("SIGINT");
  await sleep(500);
  const cleaned = output
    .split("\n")
    .filter((l) => !l.startsWith("you> ") || l.trim() !== "you>")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  writeFileSync("docs/terminal-session.txt", `${cleaned}\n`);
  console.log(cleaned);
  process.exit(0);
})();
