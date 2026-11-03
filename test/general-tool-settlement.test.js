import assert from "node:assert/strict";
import test from "node:test";
import { generalToolSettlement, nestedToolSettlement } from "../extensions/general-tool-settlement.ts";
import { sdkReceipt } from "./support/nested-receipt.js";

const pair = nestedCalls => [
  { role: "assistant", content: [{ type: "toolCall", id: "root", name: "codemode", arguments: {} }] },
  { role: "toolResult", toolCallId: "root", content: [], isError: false, nestedCalls },
];

test("SDK per-call and total-byte omissions preserve finished successes and historical failures", () => {
  for (const options of [{}, { count: 5, size: 8000 }, { failed: true }, { count: 255, size: 9000 }]) {
    const receipt = sdkReceipt(options);
    assert.equal(receipt.complete, false);
    assert.equal(generalToolSettlement(pair(receipt)).ok, true);
    if (options.failed) assert.equal(receipt.calls[0].status, "error");
  }
  assert.equal(generalToolSettlement(pair(sdkReceipt({ size: 1 }))).ok, true);
});

test("unfinished, dropped, duplicated, missing, malformed and unexplained incomplete records stay blocked", () => {
  const cases = [
    [sdkReceipt({ unfinished: true }), "NESTED_UNFINISHED"],
    [sdkReceipt({ count: 257 }), "NESTED_CALL_LIMIT"],
    [sdkReceipt({ count: 256 }), "NESTED_CALL_LIMIT"],
    [{ calls: [], complete: false }, "NESTED_INCOMPLETE"],
    [{ complete: true }, "NESTED_STRUCTURE"],
    [{ ...sdkReceipt({ size: 1 }), complete: false }, "NESTED_INCOMPLETE"],
  ];
  const mutate = (change, code) => { const receipt = sdkReceipt({ count: 2 }); change(receipt); cases.push([receipt, code]); };
  mutate(r => { r.calls[1] = r.calls[0]; }, "NESTED_DUPLICATE");
  mutate(r => { r.calls.shift(); }, "NESTED_CALL_MISSING");
  mutate(r => { r.calls[0].id = "other/1"; }, "NESTED_CALL_MISSING");
  mutate(r => { delete r.calls[0].argumentsBytes; }, "NESTED_ARGUMENT_OMISSION_UNKNOWN");
  mutate(r => { r.calls[0].argumentsBytes = 2; }, "NESTED_ARGUMENT_OMISSION_UNKNOWN");
  mutate(r => { r.calls[0].status = "unknown"; }, "NESTED_STRUCTURE");
  mutate(r => { delete r.calls[0].durationMs; }, "NESTED_STRUCTURE");
  mutate(r => { r.complete = true; }, "NESTED_INCOMPLETE");
  for (const [receipt, code] of cases) assert.equal(nestedToolSettlement(receipt, "root").code, code);
});

test("nested ancestry is checked without requiring omitted parameter bodies", () => {
  const receipt = sdkReceipt({ count: 3 });
  receipt.calls[1].id = "root/1/1";
  receipt.calls[2].id = "root/2";
  assert.equal(nestedToolSettlement(receipt, "root").ok, true);
  receipt.calls[1].id = "root/1/2";
  assert.equal(nestedToolSettlement(receipt, "root").code, "NESTED_CALL_MISSING");
});

test("only the identified preparation call can lack a result; all outer pairs remain required", () => {
  const messages = pair(sdkReceipt());
  messages.push({ role: "assistant", content: [{ type: "toolCall", id: "prepare", name: "session_handoff", arguments: {} }] });
  assert.equal(generalToolSettlement(messages, "prepare").ok, true);
  assert.equal(generalToolSettlement(messages).code, "TOOL_RESULT_MISSING");
  assert.equal(generalToolSettlement(messages.slice(0, 1).concat(messages[2]), "prepare").code, "TOOL_RESULT_MISSING");
  assert.equal(generalToolSettlement([...messages, messages[1]], "prepare").code, "TOOL_RESULT_DUPLICATE");
  assert.equal(generalToolSettlement(messages, "root").code, "PREPARING_CALL_IDENTITY");
  messages[2].content.push({ type: "toolCall", id: "other", name: "bash", arguments: {} });
  assert.equal(generalToolSettlement(messages, "prepare").code, "TOOL_RESULT_MISSING");
});
