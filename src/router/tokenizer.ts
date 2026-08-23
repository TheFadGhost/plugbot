export function tokenizeCommandLine(line: string): { tokens: string[]; problems: string[] } {
  const tokens: string[] = [];
  const problems: string[] = [];
  let current = "";
  let started = false;
  let index = 0;

  const endToken = (): void => {
    if (!started) return;
    tokens.push(current);
    current = "";
    started = false;
  };

  while (index < line.length) {
    const char = line[index]!;
    if (/\s/.test(char)) {
      endToken();
      index += 1;
      continue;
    }
    if (char === "'") {
      started = true;
      index += 1;
      let closed = false;
      while (index < line.length) {
        const inner = line[index]!;
        if (inner === "'") {
          closed = true;
          index += 1;
          break;
        }
        current += inner;
        index += 1;
      }
      if (!closed) {
        problems.push("unterminated quote");
        break;
      }
      continue;
    }
    if (char === '"') {
      started = true;
      index += 1;
      let closed = false;
      while (index < line.length) {
        const inner = line[index]!;
        if (inner === "\\") {
          const next = index + 1 < line.length ? line[index + 1] : undefined;
          if (next === '"' || next === "\\") {
            current += next;
            index += 2;
            continue;
          }
          current += inner;
          index += 1;
          continue;
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        current += inner;
        index += 1;
      }
      if (!closed) {
        problems.push("unterminated quote");
        break;
      }
      continue;
    }
    if (char === "\\") {
      const next = index + 1 < line.length ? line[index + 1] : undefined;
      if (next !== undefined) {
        current += next;
        started = true;
        index += 2;
        continue;
      }
      current += char;
      started = true;
      index += 1;
      continue;
    }
    current += char;
    started = true;
    index += 1;
  }
  endToken();
  return { tokens, problems };
}
