import type { WorkflowCompletionView, WorkflowTaskCompletionView } from "./workflow-completion-view.ts";
import type { WorkflowStatusView } from "./workflow-status-view.ts";

const WORKFLOW_STATUS_VALUES: ReadonlySet<string> = new Set(["running", "paused", "replanning", "completed", "cancelled"]);
const WORKFLOW_ACTIVITY_VALUES: ReadonlySet<string> = new Set([
  "awaiting-replan", "paused", "completed", "cancelled", "waiting-dispatch", "compaction-stalled", "compacting", "dispatching", "waiting-task", "executing",
]);

export type WorkflowPresentation =
  | { kind: "workflow-status"; view: WorkflowStatusView }
  | {
      kind: "task-completion";
      view: WorkflowTaskCompletionView;
      continuation: "next-task" | "awaiting-replan";
    }
  | { kind: "workflow-completion"; view: WorkflowCompletionView };

export function attachWorkflowPresentation<T extends object>(details: T, presentation: WorkflowPresentation) {
  return { ...details, workflowPresentation: presentation };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isOptionalIdentifier(value: unknown) {
  return value === undefined || (typeof value === "string"
    && value.trim().length > 0
    && value === value.trim()
    && value.length <= 256);
}

function isOptionalTimestamp(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isCompletionDuration(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.kind === "available") return typeof value.milliseconds === "number" && Number.isFinite(value.milliseconds);
  return value.kind === "unavailable" && value.reason === "missing-or-invalid-time";
}

function isCompletionTaskView(value: unknown): value is NonNullable<WorkflowCompletionView["finalTask"]> {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.task === "string"
    && isOptionalString(value.completionSummary)
    && isOptionalString(value.implementationRationale)
    && Array.isArray(value.verificationFailures)
    && value.verificationFailures.every((failure) => typeof failure === "string");
}

function isWorkflowStatusView(value: unknown): value is WorkflowStatusView {
  if (!isRecord(value)) return false;
  if (value.kind === "no-workflow") return true;
  if (value.kind === "restore-error") {
    return typeof value.code === "string"
      && typeof value.message === "string"
      && isOptionalIdentifier(value.sourceEntryId);
  }
  if (value.kind !== "workflow" || !isRecord(value.progress) || !isRecord(value.identity)) return false;
  const identity = value.identity;
  const action = identity.action;
  const elapsed = value.elapsed;
  return typeof value.status === "string"
    && WORKFLOW_STATUS_VALUES.has(value.status)
    && typeof value.activity === "string"
    && WORKFLOW_ACTIVITY_VALUES.has(value.activity)
    && typeof value.progress.completed === "number"
    && Number.isFinite(value.progress.completed)
    && typeof value.progress.total === "number"
    && Number.isFinite(value.progress.total)
    && (value.progress.currentTaskId === undefined || typeof value.progress.currentTaskId === "string")
    && isRecord(action)
    && typeof action.workflowId === "string"
    && typeof action.planVersion === "number"
    && Number.isFinite(action.planVersion)
    && typeof action.sessionId === "string"
    && typeof action.recoveryGeneration === "number"
    && Number.isFinite(action.recoveryGeneration)
    && typeof value.planSummary === "string"
    && isRecord(elapsed)
    && (elapsed.kind === "unavailable"
      || (elapsed.kind === "available" && typeof elapsed.milliseconds === "number" && Number.isFinite(elapsed.milliseconds)))
    && Array.isArray(value.tasks)
    && isRecord(value.pause)
    && Array.isArray(value.pause.blockedTasks);
}

function isWorkflowTaskCompletionView(value: unknown): value is WorkflowTaskCompletionView {
  return isRecord(value)
    && value.kind === "task-completion"
    && isCompletionTaskView(value.task)
    && isCompletionDuration(value.duration);
}

function isWorkflowCompletionView(value: unknown): value is WorkflowCompletionView {
  return isRecord(value)
    && value.kind === "workflow-completion"
    && typeof value.summary === "string"
    && isRecord(value.progress)
    && typeof value.progress.completed === "number"
    && Number.isFinite(value.progress.completed)
    && typeof value.progress.total === "number"
    && Number.isFinite(value.progress.total)
    && (value.finalTask === undefined || isCompletionTaskView(value.finalTask))
    && isOptionalTimestamp(value.startedAt)
    && isOptionalTimestamp(value.completedAt)
    && isCompletionDuration(value.duration);
}

export function workflowPresentationFromDetails(details: unknown): WorkflowPresentation | undefined {
  if (!isRecord(details) || !isRecord(details.workflowPresentation)) return undefined;
  const presentation = details.workflowPresentation;
  if (presentation.kind === "workflow-status" && isWorkflowStatusView(presentation.view)) {
    return { kind: "workflow-status", view: presentation.view };
  }
  if (presentation.kind === "task-completion"
    && isWorkflowTaskCompletionView(presentation.view)
    && (presentation.continuation === "next-task" || presentation.continuation === "awaiting-replan")) {
    return {
      kind: "task-completion",
      view: presentation.view,
      continuation: presentation.continuation,
    };
  }
  if (presentation.kind === "workflow-completion" && isWorkflowCompletionView(presentation.view)) {
    return { kind: "workflow-completion", view: presentation.view };
  }
  return undefined;
}
