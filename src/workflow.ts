// Public workflow operations. Internal modules import their actual owners, never this facade.
export {
  WORKFLOW_STATE_VERSION,
  WORKFLOW_IDENTITY_STATE_VERSION,
  WORKFLOW_RECOMMENDED_TASKS,
  WORKFLOW_HANDOFF_PHASES,
  WORKFLOW_CONTINUATION_KINDS,
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_EXECUTORS,
  WORKFLOW_DELEGATION_STATUSES,
  TASK_ID_PATTERN,
  WORKFLOW_STATUSES,
  WORKFLOW_TASK_STATUSES,
  WORKFLOW_AUDIT_TASK_STATUSES,
  WORKFLOW_REVISION_STATUSES,
} from "./workflow-protocol.ts";
export {
  validateWorkflowPlan,
  validateWorkflowExecutionRoles,
} from "./workflow-validation.ts";
export {
  createWorkflowState,
  cloneState,
} from "./workflow-state.ts";
export {
  getWorkflowTask,
  getNextWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  workflowProgress,
  isWorkflowRunning,
} from "./workflow-queries.ts";
export {
  hydrateWorkflowState,
} from "./workflow-hydration.ts";
export {
  startWorkflowTask,
  setWorkflowHandoffPhase,
  markWorkflowTaskStarted,
  completeWorkflowTask,
  markWorkflowTaskOutcomeUnknown,
  blockWorkflowTask,
  retryWorkflowTask,
  resumeWorkflow,
  cancelWorkflow,
  resetWorkflowNudges,
  recordWorkflowNudge,
} from "./workflow-transitions.ts";
export {
  requestWorkflowReplan,
  appendWorkflowReplanDirection,
  applyWorkflowReplan,
} from "./workflow-replan.ts";
export {
  workflowHandoffNotExecutingFailure,
  workflowHandoffAnchorMatches,
  workflowActionIdentity,
  workflowHandoffIdentity,
  workflowReplanIdentity,
  validateWorkflowMutationIdentity,
  validateWorkflowHandoffIdentity,
  validateWorkflowReplanIdentity,
  ensureWorkflowReplanHandoff,
} from "./workflow-handoff.ts";
export { recoverWorkflowState } from "./workflow-recovery.ts";
export {
  requestWorkflowGoal,
  createWorkflowGoalState,
  validateWorkflowGoalPlan,
  workflowGoalProgress,
} from "./workflow-goals.ts";
