import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generalToolSettlement } from "../extensions/general-tool-settlement.ts";
import { sdkAssistantTurn } from "./support/sdk-assistant-turn.js";
import { withTempDirectory } from "./support/temp-directory.js";

test("real SDK error/aborted proposals never execute and must not demand a nonexistent result", async () => {
  for (const stop of ["error", "aborted"]) await withTempDirectory(async cwd => {
    const path = join(cwd, "side-effect");
    const { messages } = await sdkAssistantTurn(stop, path);
    assert.equal(existsSync(path), false);
    assert.equal(messages.some(m => m.role === "toolResult"), false);
    assert.equal(generalToolSettlement(messages).ok, true);
  });
});

test("contradictory results, execution evidence and duplicate IDs are never treated as undispatched", async () => {
  await withTempDirectory(async cwd => {
    const { messages } = await sdkAssistantTurn("error", join(cwd, "unused"));
    const original = structuredClone(messages);
    const result = { role: "toolResult", toolCallId: "proposal", toolName: "write_marker", content: [], isError: false };
    assert.equal(generalToolSettlement([...messages, result]).code, "FAILED_PROPOSAL_HAS_RESULT");
    assert.equal(generalToolSettlement(messages, undefined, new Set(["proposal"])).code, "FAILED_PROPOSAL_EXECUTED");
    assert.equal(generalToolSettlement([...messages, messages.at(-1)]).code, "TOOL_CALL_DUPLICATE");
    assert.deepEqual(messages, original);
    const ordinary = structuredClone(messages);
    ordinary.at(-1).stopReason = "toolUse";
    const missing = generalToolSettlement(ordinary);
    assert.equal(missing.code, "TOOL_RESULT_MISSING");
    assert.ok(missing.message.includes("proposal"));
    ordinary.at(-1).stopReason = "length";
    assert.equal(generalToolSettlement(ordinary).code, "TOOL_RESULT_MISSING");
    assert.equal(generalToolSettlement([result]).code, "TOOL_RESULT_WITHOUT_CALL");
  });
});

test("real SDK toolUse executes while length produces an error receipt without executing", async () => {
  for (const stop of ["toolUse", "length"]) await withTempDirectory(async cwd => {
    const path = join(cwd, "side-effect");
    const { messages } = await sdkAssistantTurn(stop, path);
    assert.equal(existsSync(path), stop === "toolUse");
    const receipt = messages.find(m => m.role === "toolResult");
    assert.ok(receipt);
    assert.equal(receipt.isError, stop === "length");
    assert.equal(generalToolSettlement(messages).ok, true);
  });
});
