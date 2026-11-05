import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolResult } from "../extensions/handoff-tool-diagnostics.ts";

test("tool summaries retain the SDK structured exit code alongside result details", () => {
  const summary = summarizeToolResult({
    details: { truncation: { truncated: true, outputBytes: 120 } },
    structuredContent: { exit_code: 1, output: "private-output", wall_time_seconds: 3.5 },
  }, false);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.truncated, true);
  assert.equal(summary.outputBytes, 120);
  assert.equal(JSON.stringify(summary).includes("private-output"), false);
  assert.equal(summarizeToolResult({ structuredContent: { exit_code: 0 } }, false).exitCode, 0);
  assert.equal(summarizeToolResult({ details: { exitCode: 2 }, structuredContent: { exit_code: 1 } }, false).exitCode, 2);
  assert.equal(summarizeToolResult({ structuredContent: { exit_code: "1" } }, false).exitCode, undefined);
  assert.equal(summarizeToolResult({ content: [{ text: "exit_code: 1" }] }, false).exitCode, undefined);
});
