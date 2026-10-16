import type { FileSnapshot } from "./file-review.ts";
import type { ReviewCandidateQueueResult } from "./review-candidates.ts";

export type IncrementalReviewCandidate = {
  kind: "structure";
  file: FileSnapshot;
  version: string;
};

type IncrementalReviewState = {
  baseline: Map<string, string>;
  baselineComplete: boolean;
  changes: Map<string, string | null>;
  structuralCandidates: Map<string, Omit<IncrementalReviewCandidate, "kind">>;
  notifiedVersions: Set<string>;
};

export function createIncrementalReviewState(files: readonly FileSnapshot[], complete: boolean): IncrementalReviewState {
  return {
    baseline: new Map(files.map((file) => [file.path, file.fingerprint])),
    baselineComplete: complete,
    changes: new Map(),
    structuralCandidates: new Map(),
    notifiedVersions: new Set(),
  };
}

export function observeIncrementalReviewFiles(
  state: IncrementalReviewState,
  files: readonly FileSnapshot[],
  complete: boolean,
) {
  const current = new Map(files.map((file) => [file.path, file.fingerprint]));
  for (const file of files) {
    const baselineFingerprint = state.baseline.get(file.path);
    if (baselineFingerprint === undefined) {
      if (state.baselineComplete) state.changes.set(file.path, file.fingerprint);
      else state.baseline.set(file.path, file.fingerprint);
    } else if (baselineFingerprint === file.fingerprint) {
      state.changes.delete(file.path);
    } else {
      state.changes.set(file.path, file.fingerprint);
    }
  }

  if (complete) {
    for (const path of state.baseline.keys()) {
      if (!current.has(path)) state.changes.set(path, null);
    }
    for (const path of state.changes.keys()) {
      if (!current.has(path)) state.changes.set(path, null);
    }
    state.baselineComplete = true;
  }
}

function currentChange(state: IncrementalReviewState, path: string, fingerprint: string | null) {
  return state.changes.has(path) && state.changes.get(path) === fingerprint;
}

function structureVersion(file: FileSnapshot, policyVersion: number) {
  return JSON.stringify(["structure", file.path, file.fingerprint, policyVersion]);
}

export function refreshIncrementalReviewCandidates(
  state: IncrementalReviewState,
  queue: ReviewCandidateQueueResult,
  policyVersion: number,
) {
  if (!queue.structuralConfirmed) return;
  state.structuralCandidates.clear();
  for (const file of queue.structuralCandidates) {
    if (currentChange(state, file.path, file.fingerprint)) {
      state.structuralCandidates.set(file.path, {
        file,
        version: structureVersion(file, policyVersion),
      });
    }
  }
}

export function incrementalReviewCandidates(state: IncrementalReviewState): IncrementalReviewCandidate[] {
  return [...state.structuralCandidates.values()].map((candidate) => ({ kind: "structure", ...candidate }));
}

export function unnotifiedIncrementalReviewCandidates(
  state: IncrementalReviewState,
  structuralConfirmed: boolean,
) {
  return incrementalReviewCandidates(state).filter((candidate) =>
    structuralConfirmed && !state.notifiedVersions.has(candidate.version),
  );
}

export function markIncrementalReviewNotified(
  state: IncrementalReviewState,
  candidates: readonly IncrementalReviewCandidate[],
) {
  for (const candidate of candidates) state.notifiedVersions.add(candidate.version);
}

export type { IncrementalReviewState };
