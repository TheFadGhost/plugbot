export type ThemeName = "dark" | "light";

export type TokenName =
  | "fgMuted"
  | "levelDebug"
  | "levelInfo"
  | "levelWarn"
  | "levelError"
  | "fgName"
  | "fgPrompt"
  | "fgRef";

type TokenTable = Readonly<Record<TokenName, string>>;

const DARK: TokenTable = {
  fgMuted: "90",
  levelDebug: "90",
  levelInfo: "96",
  levelWarn: "93",
  levelError: "91",
  fgName: "94",
  fgPrompt: "96",
  fgRef: "90",
};

const LIGHT: TokenTable = {
  fgMuted: "90",
  levelDebug: "32",
  levelInfo: "34",
  levelWarn: "33",
  levelError: "31",
  fgName: "35",
  fgPrompt: "34",
  fgRef: "90",
};

const THEMES: Readonly<Record<ThemeName, TokenTable>> = { dark: DARK, light: LIGHT };

export const resetCode = "\u001B[0m";

export function applyTheme(token: TokenName, text: string, enabled: boolean, theme: ThemeName = "dark"): string {
  if (!enabled || text === "") return text;
  const table = THEMES[theme] ?? DARK;
  return `\u001B[${table[token]}m${text}${resetCode}`;
}
