import { jsonHash as hash } from "./json-hash.ts";
import { createFileReviewState, readFileReviewState, FILE_REVIEW_POLICY_VERSION, type FileReviewDecision, type PersistedFileReviewState, type StateReadResult } from "./file-review.ts";

export const FILE_REVIEW_SNAPSHOT_INTERVAL = 25;

type JournalBase = Omit<PersistedFileReviewState, "schemaVersion" | "decisions"> & {
  schemaVersion: 2; revision: number; hash: string;
};
export type FileReviewJournalEntry = JournalBase & (
  | { kind: "snapshot"; decisions: FileReviewDecision[] }
  | { kind: "delta"; baseHash: string; decision: FileReviewDecision }
);

export function createFileReviewJournalEntry(previous: PersistedFileReviewState, next: PersistedFileReviewState,
  revision: number): FileReviewJournalEntry {
  const { decisions, schemaVersion: _schema, ...identity } = next;
  const base = { ...identity, schemaVersion: 2 as const, revision, hash: hash(next) };
  if (revision === 1 || revision % FILE_REVIEW_SNAPSHOT_INTERVAL === 0) {
    return { ...base, kind: "snapshot", decisions };
  }
  return { ...base, kind: "delta", baseHash: hash(previous), decision: decisions.at(-1)! };
}

export function restoreFileReviewJournal(entries: readonly unknown[], projectRoot: string, sessionId: string):
  { state: StateReadResult; revision: number } {
  let state: StateReadResult = { ok: true, value: createFileReviewState(projectRoot, sessionId) };
  let revision = 0;
  const invalid = (): StateReadResult => ({ ok: false, code: "INVALID_STATE", message: "保存的审阅增量链不完整或校验失败" });
  for (const value of entries) {
    if (!value || typeof value !== "object") { state = invalid(); continue; }
    const entry = value as Record<string, unknown>;
    // Records inherited from another project/session never authorize this session's reviews.
    if (entry.projectRoot !== projectRoot || entry.sessionId !== sessionId) {
      state = { ok: true, value: createFileReviewState(projectRoot, sessionId) }; revision = 0; continue;
    }
    if (entry.schemaVersion === 1) {
      state = readFileReviewState(entry, projectRoot, sessionId); revision = 0; continue;
    }
    if (entry.schemaVersion !== 2 || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1) {
      state = invalid(); continue;
    }
    if (entry.policyVersion !== FILE_REVIEW_POLICY_VERSION && ["snapshot", "delta"].includes(String(entry.kind))) {
      state = { ok: false, code: "POLICY_MISMATCH", message: "保存的大文件审阅状态使用了旧策略版本" };
      revision = 0;
      continue;
    }
    if (entry.kind === "snapshot") {
      const restored = readFileReviewState({ ...entry, schemaVersion: 1 }, projectRoot, sessionId);
      state = restored.ok && hash(restored.value) !== entry.hash ? invalid() : restored;
    } else if (entry.kind === "delta" && state.ok && revision > 0 && entry.revision === revision + 1
      && hash(state.value) === entry.baseHash) {
      const checked = readFileReviewState({ ...entry, schemaVersion: 1, decisions: [entry.decision] }, projectRoot, sessionId);
      if (!checked.ok) state = checked;
      else {
        const decision = checked.value.decisions[0]!;
        const next = { ...state.value, decisions: [...state.value.decisions.filter(item => item.path !== decision.path), decision] };
        state = hash(next) === entry.hash ? { ok: true, value: next } : invalid();
      }
    } else state = invalid();
    revision = Number(entry.revision);
  }
  return { state, revision };
}
