/**
 * Rendering of ConfigViolation lists per DESIGN.md section 6. Unknown-key
 * violations carry their suggestion in `actual`; missing-required violations
 * ignore `actual` and render "but it is absent".
 */

import type { ConfigViolation } from "../errors.js";

const UNKNOWN_KEY = "unknown key";
const MISSING_REQUIRED = "missing required key";
const MAX_ARRAY_ITEMS = 5;
const MAX_RENDER_CHARS = 96;

export function expectedOneOf(values: readonly string[]): string {
  return `expected one of ${values.map((value) => JSON.stringify(value)).join(", ")}`;
}

function truncate(text: string): string {
  return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS - 3)}...` : text;
}

export function renderActualValue(value: unknown): string {
  if (typeof value === "string") return truncate(JSON.stringify(value));
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return `len ${value.length} [...]`;
    return truncate(JSON.stringify(value));
  }
  if (value === null) return "null";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json === undefined ? "object" : truncate(json);
  }
  return String(value);
}

function groupRank(violation: ConfigViolation): number {
  if (violation.expectation === UNKNOWN_KEY) return 0;
  if (violation.expectation === MISSING_REQUIRED) return 2;
  return 1;
}

function compareViolations(a: ConfigViolation, b: ConfigViolation): number {
  const rank = groupRank(a) - groupRank(b);
  if (rank !== 0) return rank;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

export function renderViolations(violations: readonly ConfigViolation[]): string[] {
  const lines: string[] = [];
  const sorted = [...violations].sort(compareViolations);
  for (const violation of sorted) {
    if (violation.expectation === UNKNOWN_KEY) {
      lines.push(`config error: ${violation.key}: ${UNKNOWN_KEY}`);
    } else if (violation.expectation === MISSING_REQUIRED) {
      lines.push(`config error: ${violation.key}: ${MISSING_REQUIRED}, but it is absent`);
    } else {
      lines.push(`config error: ${violation.key}: ${violation.expectation}, got ${violation.actual}`);
    }
    lines.push(`  at ${violation.source}  key "${violation.key}"`);
    if (violation.expectation === UNKNOWN_KEY && violation.actual !== "") {
      lines.push(`  did you mean "${violation.actual}"?`);
    }
  }
  return lines;
}
