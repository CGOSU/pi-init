import type { FileSnapshot } from "./file-review.ts";
import type { ReviewCandidateQueueResult } from "./review-candidates.ts";
import type {
  PendingTestValueReview,
  TestValueReviewDecision,
} from "./test-value-review.ts";

export type IncrementalReviewCandidate =
  | { kind: "structure"; file: FileSnapshot; version: string }
  | { kind: "test-value"; review: PendingTestValueReview; version: string };

type IncrementalReviewState = {
  baseline: Map<string, string>;
  baselineComplete: boolean;
  changes: Map<string, string | null>;
  structurePolicyVersion: number;
  valuePolicyVersion: number;
  structuralCandidates: Map<string, Omit<Extract<IncrementalReviewCandidate, { kind: "structure" }>, "kind">>;
  valueCandidates: Map<string, Omit<Extract<IncrementalReviewCandidate, { kind: "test-value" }>, "kind">>;
  notifiedVersions: Set<string>;
};

export function createIncrementalReviewState(
  files: readonly FileSnapshot[],
  complete: boolean,
  structurePolicyVersion: number,
  valuePolicyVersion: number,
): IncrementalReviewState {
  return {
    baseline: new Map(files.map((file) => [file.path, file.fingerprint])),
    baselineComplete: complete,
    changes: new Map(),
    structurePolicyVersion,
    valuePolicyVersion,
    structuralCandidates: new Map(),
    valueCandidates: new Map(),
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

function valueVersion(
  review: PendingTestValueReview,
  decisions: readonly TestValueReviewDecision[],
  files: ReadonlyMap<string, FileSnapshot>,
  policyVersion: number,
) {
  const decision = decisions.find((item) => item.testPath === review.file.path);
  const implementations = (decision?.implementationFiles ?? [])
    .map((implementation) => [implementation.path, files.get(implementation.path)?.fingerprint ?? null] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    "test-value",
    review.file.path,
    review.file.fingerprint,
    implementations,
    policyVersion,
  ]);
}

export function refreshIncrementalReviewCandidates(
  state: IncrementalReviewState,
  queue: ReviewCandidateQueueResult,
  files: ReadonlyMap<string, FileSnapshot>,
  decisions: readonly TestValueReviewDecision[],
  structurePolicyVersion: number,
  valuePolicyVersion: number,
) {
  if (queue.structuralConfirmed) {
    state.structuralCandidates.clear();
    for (const file of queue.structuralCandidates) {
      if (currentChange(state, file.path, file.fingerprint)) {
        state.structuralCandidates.set(file.path, {
          file,
          version: structureVersion(file, structurePolicyVersion),
        });
      }
    }
  }

  if (queue.testValueConfirmed) {
    state.valueCandidates.clear();
    for (const review of queue.testValueCandidates) {
      const testChanged = currentChange(state, review.file.path, review.file.fingerprint);
      const decision = decisions.find((item) => item.testPath === review.file.path);
      const associatedImplementationChanged = (decision?.implementationFiles ?? []).some((implementation) => {
        const currentFingerprint = files.get(implementation.path)?.fingerprint ?? null;
        return state.changes.has(implementation.path)
          && currentChange(state, implementation.path, currentFingerprint)
          && currentFingerprint !== implementation.fingerprint;
      });
      const policyChanged = state.valuePolicyVersion !== valuePolicyVersion
        && review.invalidations.some((invalidation) => invalidation.code === "POLICY_CHANGED");
      if (testChanged || associatedImplementationChanged || policyChanged) {
        state.valueCandidates.set(review.file.path, {
          review,
          version: valueVersion(review, decisions, files, valuePolicyVersion),
        });
      }
    }
  }
}

export function incrementalReviewCandidates(state: IncrementalReviewState): IncrementalReviewCandidate[] {
  return [
    ...[...state.structuralCandidates.values()].map((candidate) => ({ kind: "structure" as const, ...candidate })),
    ...[...state.valueCandidates.values()].map((candidate) => ({ kind: "test-value" as const, ...candidate })),
  ];
}

export function unnotifiedIncrementalReviewCandidates(
  state: IncrementalReviewState,
  confirmed: { structural: boolean; testValue: boolean },
) {
  return incrementalReviewCandidates(state).filter((candidate) =>
    (candidate.kind === "structure" ? confirmed.structural : confirmed.testValue)
    && !state.notifiedVersions.has(candidate.version),
  );
}

export function markIncrementalReviewNotified(
  state: IncrementalReviewState,
  candidates: readonly IncrementalReviewCandidate[],
) {
  for (const candidate of candidates) state.notifiedVersions.add(candidate.version);
}

export type { IncrementalReviewState };
