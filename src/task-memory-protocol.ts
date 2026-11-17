// Task memory persistence and context-view protocol.
export const TASK_MEMORY_ENTRY = "pi-init-task-memory";
export const TASK_MEMORY_MESSAGE = "pi-init-task-memory-view";

const pinnedObservations = 32;
const recentObservations = 16;

export const TASK_MEMORY_LIMITS = Object.freeze({
  stepLength: 200,
  textLength: 512,
  evidenceIdLength: 256,
  accomplishments: 16,
  evidencePerAccomplishment: 8,
  remaining: 32,
  blockers: 16,
  files: 16,
  evidencePerRequest: 8,
  pinnedObservations,
  recentObservations,
  observations: pinnedObservations + recentObservations,
} as const);
