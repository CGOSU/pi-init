import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import fs, { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createFileReviewSession } from "../extensions/file-review-session.ts";
import { createFileReviewObserver } from "../extensions/file-review-observer.ts";
import { FILE_REVIEW_ENTRY_TYPE } from "../src/file-review.ts";
import { withTempDirectory } from "./support/temp-directory.js";

const originalText = Array.from({ length: 501 }, (_, i) => `export const item${i} = ${i};`).join("\n");
const rationale = "Independent cohesive module; no additional split is needed.";

async function fixture(run) {
  await withTempDirectory(async cwd => {
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/large.ts"), originalText);
    const entries = [{ id: "root", type: "message" }];
    const ctx = { cwd, sessionManager: { getSessionId: () => "s1", getBranch: () => entries } };
    const append = data => entries.push({ id: `journal-${entries.length}`, type: "custom", customType: FILE_REVIEW_ENTRY_TYPE, data });
    const sessions = createFileReviewSession(append);
    await sessions.restore(ctx);
    await run({ ctx, entries, append, sessions, file: sessions.pending()[0] });
  });
}

function nativeRead() {
  return {
    type: "tool_result", toolName: "read", toolCallId: "read-1", input: { path: "src/large.ts" },
    content: [{ type: "text", text: originalText }], isError: false
  };
}

test("session stores isolate read evidence and observe another store's review only after restoring its journal", async () => fixture(async ({ ctx, append, sessions, file }) => {
  const other = createFileReviewSession(append);
  await other.restore(ctx);
  sessions.recordRead(sessions.getState(), file, 1, file.lineCount);
  assert.equal(sessions.completeReadEvidence(file), true);
  assert.equal(other.completeReadEvidence(file), false);
  assert.equal(sessions.recordReview(sessions.getState(), file, "keep", rationale).ok, true);
  assert.equal(sessions.pending().length, 0);
  assert.equal(other.pending().length, 1);
  await other.restore(ctx);
  assert.equal(other.pending().length, 0);
}));

test("journal failure preserves memory and read evidence; a successful retry appends before committing memory", async () => fixture(async ({ ctx, append, file }) => {
  let fail = true;
  let sessions;
  sessions = createFileReviewSession(data => {
    assert.equal(sessions.pending().length, 1);
    assert.equal(sessions.getState().reviewRevision, 0);
    assert.equal(sessions.completeReadEvidence(file), true);
    if (fail) throw new Error("fixture storage failure");
    append(data);
  });
  await sessions.restore(ctx);
  const current = sessions.getState();
  sessions.recordRead(current, file, 1, file.lineCount);
  const rejected = sessions.recordReview(current, file, "keep", rationale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "PERSIST_FAILED");
  assert.equal(current.reviewRevision, 0);
  assert.equal(sessions.pending().length, 1);
  assert.equal(sessions.completeReadEvidence(file), true);
  fail = false;
  assert.equal(sessions.recordReview(current, file, "keep", rationale).ok, true);
  assert.equal(current.reviewRevision, 1);
  assert.equal(sessions.pending().length, 0);
  assert.equal(sessions.completeReadEvidence(file), false);
  await sessions.restore(ctx);
  assert.equal(sessions.pending().length, 0);
}));

for (const change of ["session", "branch", "generation"]) {
  test(`native read proof cannot cross a ${change} boundary while original text is being checked`, async () => fixture(async ({ ctx, sessions, entries, file }) => {
    const observe = createFileReviewObserver(sessions);
    const original = fs.readFile;
    let reads = 0;
    try {
      fs.readFile = async (...args) => {
        const contents = await original(...args);
        // The first inspection refreshes inventory; the next verifies returned original text.
        if (++reads === 2) {
          if (change === "session") ctx.sessionManager.getSessionId = () => "s2";
          if (change === "branch") entries.splice(0, entries.length, { id: "fork", type: "message" });
          if (change === "generation") await sessions.restore(ctx);
        }
        return contents;
      };
      syncBuiltinESMExports();
      await observe(nativeRead(), ctx);
      assert.equal(sessions.completeReadEvidence(file), false);
      assert.equal(sessions.getState().readCoverage.size, 0);
    } finally {
      fs.readFile = original;
      syncBuiltinESMExports();
    }
    await sessions.restore(ctx);
    await observe(nativeRead(), ctx);
    assert.equal(sessions.completeReadEvidence(sessions.pending()[0]), true);
  }));
}

test("a delayed snapshot cannot credit coverage for a newer inventory fingerprint", async () => fixture(async ({ ctx, sessions, file }) => {
  const current = sessions.getState();
  await writeFile(join(ctx.cwd, file.path), originalText.replace("= 0", "= 999"));
  const latest = await sessions.refreshSpecificFile(ctx, file.path);
  assert.equal(latest.ok, true);
  assert.notEqual(latest.file.fingerprint, file.fingerprint);
  sessions.recordRead(current, file, 1, file.lineCount);
  assert.equal(sessions.completeReadEvidence(latest.file), false);
  assert.equal(current.readCoverage.size, 0);
  sessions.recordRead(current, latest.file, 1, latest.file.lineCount);
  assert.equal(sessions.completeReadEvidence(latest.file), true);
}));

test("an obsolete session cannot persist review state or alter the new session", async () => fixture(async ({ ctx, sessions, entries, file }) => {
  const old = sessions.getState();
  await sessions.restore(ctx);
  const rejected = sessions.recordReview(old, file, "keep", rationale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "STALE_SESSION");
  assert.equal(entries.filter(entry => entry.customType === FILE_REVIEW_ENTRY_TYPE).length, 0);
  assert.equal(sessions.pending().length, 1);
}));
