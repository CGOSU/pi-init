import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  TEST_VALUE_ENTRY_TYPE,
  createTestValueReviewSessionState,
  pendingTestValueCandidates,
  recordValueReview,
  restoreTestValueReviewSession,
  testValuePersistedState,
} from "../extensions/test-value-review-runtime.ts";

const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
const file = (path, value) => ({ path, fingerprint: fingerprint(value), lineCount: 1, size: "1", modifiedAt: "1" });
const scan = (...files) => ({ ok: true, projectRoot: "/project", files, errors: [] });

test("测试价值运行时状态默认无记录且持久化结构独立", () => {
  const state = createTestValueReviewSessionState();
  assert.deepEqual(state, { decisions: [], errors: [] });
  const persisted = testValuePersistedState("/project", "session-a", []);
  assert.deepEqual(persisted, {
    schemaVersion: 1,
    policyVersion: 1,
    projectRoot: "/project",
    sessionId: "session-a",
    decisions: [],
  });
  assert.equal(TEST_VALUE_ENTRY_TYPE, "pi-init-test-value-review");
});

test("会话恢复区分同会话损坏记录与其它来源，并只读取价值条目", () => {
  const testFile = file("test/unit.test.ts", "test");
  const implementation = file("src/service.ts", "impl");
  const recorded = recordValueReview([], scan(testFile, implementation), "session-a", testFile.path, [implementation.path], "keep", "覆盖关键边界测试", 1);
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;
  const valueEntry = { type: "custom", customType: TEST_VALUE_ENTRY_TYPE, data: recorded.value };
  const structuralEntry = {
    type: "custom",
    customType: "pi-init-file-review",
    data: { schemaVersion: 1, policyVersion: 1, projectRoot: "/project", sessionId: "session-a", decisions: [] },
  };

  const restored = restoreTestValueReviewSession([structuralEntry, valueEntry], "/project", "session-a");
  assert.equal(restored.decisions.length, 1);
  assert.deepEqual(restored.errors, []);

  const otherSession = restoreTestValueReviewSession([valueEntry], "/project", "session-b");
  assert.deepEqual(otherSession.decisions, []);
  assert.deepEqual(otherSession.errors, []);

  const corrupted = restoreTestValueReviewSession(
    [{
      type: "custom",
      customType: TEST_VALUE_ENTRY_TYPE,
      data: { schemaVersion: 1, policyVersion: 1, projectRoot: "/project", sessionId: "session-a", decisions: [{ testPath: "test/a.test.ts" }] },
    }],
    "/project",
    "session-a",
  );
  assert.deepEqual(corrupted.decisions, []);
  assert.equal(corrupted.errors[0].code, "INVALID_STATE");

  const otherProject = restoreTestValueReviewSession(
    [{ type: "custom", customType: TEST_VALUE_ENTRY_TYPE, data: { schemaVersion: 1, decisions: [] } }],
    "/project",
    "session-a",
  );
  assert.deepEqual(otherProject.decisions, []);
  assert.deepEqual(otherProject.errors, []);
});

test("价值候选在扫描错误或状态不可读时返回结构化错误而非空队列", () => {
  const ok = pendingTestValueCandidates([file("test/a.test.ts", "a")], [], []);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.pending.length, 1);

  const incomplete = pendingTestValueCandidates(
    [file("test/a.test.ts", "a")],
    [{ code: "FILE_UNREADABLE", path: "test/a.test.ts", message: "permission denied" }],
    [],
  );
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.error.code, "SCAN_INCOMPLETE");

  const staleDecision = {
    testPath: "test/a.test.ts",
    testFingerprint: fingerprint("a"),
    implementationFiles: [{ path: "src/x.ts", fingerprint: fingerprint("x") }],
    policyVersion: 1,
    conclusion: "keep",
    rationale: "保持覆盖",
    reviewedAt: 1,
  };
  const rePending = pendingTestValueCandidates([file("test/a.test.ts", "changed")], [], [staleDecision]);
  assert.equal(rePending.ok, true);
  if (rePending.ok) {
    assert.equal(rePending.pending.length, 1);
    assert.ok(rePending.pending[0].invalidations.some((entry) => entry.code === "TEST_CHANGED"));
  }
});
