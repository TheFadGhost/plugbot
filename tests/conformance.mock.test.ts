import { describe, expect, it } from "vitest";
import { MockAdapter } from "../src/adapter/mock.js";
import {
  describeAdapterConformance,
  runAdapterConformance,
} from "../src/testing/conformance.js";

await describeAdapterConformance("mock", () => new MockAdapter());

describe("mock conformance direct report", () => {
  it("reports zero failures across every check", async () => {
    const report = await runAdapterConformance(() => new MockAdapter());
    expect(report.adapter).toBe("mock");
    expect(report.checks).toBeGreaterThanOrEqual(8);
    expect(
      report.failures,
      `unexpected failures:\n${report.failures.map((failure) => `  - ${failure}`).join("\n")}`,
    ).toEqual([]);
  });
});
