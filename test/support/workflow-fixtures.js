import {
  createWorkflowState as createWorkflowStateRaw,
  markWorkflowTaskStarted as markWorkflowTaskStartedRaw,
  setWorkflowHandoffPhase,
} from "../../src/workflow.ts";

const createWorkflowState = (input, now) => createWorkflowStateRaw({ sessionId: "test-session", ...input }, now);
const markWorkflowTaskStarted = (state, taskId, now) => markWorkflowTaskStartedRaw(state.handoff?.phase === "executing" ? state : setWorkflowHandoffPhase(state, "queued"), taskId, now);

const workflowMessageIdentity = (harness, customType = "pi-init-workflow-task") => harness.sentMessages.findLast(({ message }) => message.customType === customType)?.message.details;

export { createWorkflowState, markWorkflowTaskStarted, workflowMessageIdentity };
