// Task memory persistence and context-view protocol.
export const TASK_MEMORY_ENTRY = "pi-init-task-memory";
export const TASK_MEMORY_MESSAGE = "pi-init-task-memory-view";
/**
 * How tool results are derived into observations (summary bounding, fingerprints, failure rule).
 * Bump whenever any derived field changes. Snapshots without the field are derivation 1.
 * 2: outcome uses the same structured failure rule as progress and verification sources.
 * 3: observation summaries are bounded to observationSummary characters.
 */
export const TASK_OBSERVATION_DERIVATION = 3;

const pinnedObservations = 32;
const recentObservations = 16;

export const TASK_MEMORY_LIMITS = Object.freeze({
  stepLength: 200,
  // Derived summary bound. Raising it or changing the bounding requires a new derivation.
  observationSummary: 512,
  textLength: 512,
  evidenceIdLength: 256,
  accomplishments: 16,
  evidencePerAccomplishment: 8,
  remaining: 32,
  blockers: 16,
  files: 16,
  evidencePerRequest: 8,
  // Turn-end snapshots are written after this many unsaved results; observations are re-derived from the branch.
  snapshotEveryResults: 8,
  pinnedObservations,
  recentObservations,
  observations: pinnedObservations + recentObservations,
} as const);
