import assert from "node:assert/strict";
import test from "node:test";
import { createFileReviewState, recordFileReview } from "../src/file-review.ts";
import { createFileReviewJournalEntry, restoreFileReviewJournal, FILE_REVIEW_SNAPSHOT_INTERVAL } from "../src/file-review-journal.ts";

const root = "/project", session = "session";
function add(state, number) {
  return recordFileReview(state, { path: `src/file${number}.ts`, lineCount: 501, fingerprint: "a".repeat(64) }, "keep", "保持单一职责，不需要拆分。", number);
}
function journal(count) {
  let state = createFileReviewState(root, session);
  const entries = [];
  for (let n = 1; n <= count; n++) {
    const next = add(state, n);
    entries.push(createFileReviewJournalEntry(state, next, n)); state = next;
  }
  return { state, entries };
}

test("review journal bounds repeated storage and restores periodic snapshots and branch prefixes", () => {
  const { state, entries } = journal(52);
  assert.deepEqual(entries.filter(e => e.kind === "snapshot").map(e => e.revision), [1, FILE_REVIEW_SNAPSHOT_INTERVAL, 50]);
  assert.ok(entries.slice(1, 24).every(e => e.kind === "delta" && !("decisions" in e)));
  assert.equal(entries.reduce((sum, entry) => sum + (entry.decisions?.length ?? 1), 0), 125);
  assert.deepEqual(restoreFileReviewJournal(entries, root, session).state.value, state);
  assert.equal(restoreFileReviewJournal(entries.slice(0, 12), root, session).state.value.decisions.length, 12);
  assert.deepEqual(restoreFileReviewJournal(entries.slice(49), root, session).state.value, state);
  const fork = entries.slice(0, 12);
  const parent = restoreFileReviewJournal(fork, root, session);
  const changed = add(parent.state.value, 100);
  fork.push(createFileReviewJournalEntry(parent.state.value, changed, parent.revision + 1));
  assert.deepEqual(restoreFileReviewJournal(fork, root, session).state.value.decisions.map(d => d.path), changed.decisions.map(d => d.path));
});

test("review journal accepts legacy states but rejects missing, reordered and corrupt deltas", () => {
  const { entries, state } = journal(4);
  const legacy = add(createFileReviewState(root, session), 0);
  const next = add(legacy, 1);
  const first = createFileReviewJournalEntry(legacy, next, 1);
  assert.equal(first.kind, "snapshot");
  assert.deepEqual(restoreFileReviewJournal([legacy, first], root, session).state.value, next);
  assert.equal(restoreFileReviewJournal([legacy], root, session).state.value.decisions.length, 1);
  const variants = [entries.slice(1), [entries[0], entries[2]], [entries[0], entries[1], entries[1]],
    [entries[0], { ...entries[1], baseHash: "b".repeat(64) }],
    [entries[0], { ...entries[1], hash: "b".repeat(64) }],
    [entries[0], { ...entries[1], decision: { ...entries[1].decision, path: "../outside.ts" } }],
    [{ ...entries[0], decisions: [], hash: entries[0].hash }],
    [entries[0], { ...entries[1], revision: 1.5 }],
    [entries[0], { ...entries[1], schemaVersion: 99 }]];
  for (const values of variants) assert.equal(restoreFileReviewJournal(values, root, session).state.ok, false);
  assert.deepEqual(restoreFileReviewJournal(entries, root, "other").state.value.decisions, []);
  assert.deepEqual(restoreFileReviewJournal(entries, "/other", session).state.value.decisions, []);
  assert.deepEqual(restoreFileReviewJournal([null, createFileReviewJournalEntry(state, state, 25)], root, session).state.value, state);
});


test("245 review records use substantially less persisted payload than cumulative snapshots", () => {
  const { entries, state } = journal(245);
  const bytes = values => values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  const snapshots = state.decisions.map((_, index) => ({ ...state, decisions: state.decisions.slice(0, index + 1) }));
  assert.ok(bytes(entries) < bytes(snapshots) / 10);
  assert.deepEqual(restoreFileReviewJournal(entries, root, session).state.value, state);
});

test("a retired policy journal resets revision so the first current-policy write is a recoverable snapshot", () => {
  const { entries } = journal(2);
  const old = entries.map(entry => ({ ...entry, policyVersion: 0 }));
  for (const prefix of [old.slice(0, 1), old]) {
    const restored = restoreFileReviewJournal(prefix, root, session);
    assert.equal(restored.state.code, "POLICY_MISMATCH");
    assert.equal(restored.revision, 0);
    const empty = createFileReviewState(root, session), next = add(empty, 3);
    const write = createFileReviewJournalEntry(empty, next, restored.revision + 1);
    assert.equal(write.kind, "snapshot");
    assert.deepEqual(restoreFileReviewJournal([...prefix, write], root, session).state.value, next);
  }
});
