import { isObject as isRecord } from "../src/value-guards.ts";
import type { WorkflowCompletionView, WorkflowTaskCompletionView } from "./workflow-completion-view.ts";
import type { WorkflowStatusView } from "./workflow-status-view.ts";

const WORKFLOW_STATUS_VALUES: ReadonlySet<string> = new Set(["running", "paused", "replanning", "completed", "cancelled"]);
const WORKFLOW_ACTIVITY_VALUES: ReadonlySet<string> = new Set([
  "awaiting-replan", "execution-blocked", "paused", "completed", "cancelled", "waiting-dispatch", "compaction-stalled", "compacting", "dispatching", "waiting-task", "executing",
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
    && (value.progress.currentTaskPosition === undefined
      || (typeof value.progress.currentTaskPosition === "number"
        && Number.isSafeInteger(value.progress.currentTaskPosition)
        && value.progress.currentTaskPosition >= 1
        && value.progress.currentTaskPosition <= value.progress.total
        && typeof value.progress.currentTaskId === "string"))
    && isRecord(action)
    && typeof action.workflowId === "string"
    && typeof action.planVersion === "number"
    && Number.isFinite(action.planVersion)
    && typeof action.sessionId === "string"
    && typeof action.recoveryGeneration === "number"
    && Number.isFinite(action.recoveryGeneration)
    && typeof value.planSummary === "string"
    && (value.recovery === undefined || (isRecord(value.recovery)
      && typeof value.recovery.code === "string"
      && typeof value.recovery.message === "string"
      && typeof value.recovery.nextAction === "string"))
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

type PresentationResult = { ok: true; value: WorkflowPresentation } | { ok: false; code: string; message: string };
function invalidPresentation(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: "WORKFLOW_PRESENTATION_" + code, message };
}

function validateVerificationView(value: unknown): { ok: true; value: NonNullable<WorkflowCompletionView["finalTask"]> } | { ok: false; code: string; message: string } {
  if (!isCompletionTaskView(value)) return invalidPresentation("TASK_TYPE", "完成任务视图字段无效");
  for (const field of ["verification", "verificationFailures", "verificationPending", "verificationUnclassified"]) {
    const records = value[field as keyof typeof value];
    if (!Array.isArray(records) || !records.every(item => typeof item === "string")) {
      return invalidPresentation("VERIFICATION_FIELD", "缺少或非法的完成视图字段：" + field);
    }
  }
  return { ok: true, value };
}

export function workflowPresentationFromDetails(details: unknown): PresentationResult {
  if (!isRecord(details) || !isRecord(details.workflowPresentation)) return invalidPresentation("MISSING", "未记录结构化展示");
  const presentation = details.workflowPresentation;
  if (presentation.kind === "task-completion") {
    const error = validateVerificationView(isRecord(presentation.view) ? presentation.view.task : undefined);
    if (!error.ok) return error;
  }
  if (presentation.kind === "workflow-completion") {
    if (!isRecord(presentation.view) || !Array.isArray(presentation.view.tasks)) return invalidPresentation("TASKS_TYPE", "完成报告缺少任务数组");
    for (const task of [...presentation.view.tasks, ...(presentation.view.finalTask ? [presentation.view.finalTask] : [])]) {
      const error = validateVerificationView(task);
      if (!error.ok) return error;
    }
  }
  if (presentation.kind === "workflow-status" && isWorkflowStatusView(presentation.view)) {
    return { ok: true, value: { kind: "workflow-status", view: presentation.view } };
  }
  if (presentation.kind === "task-completion"
    && isWorkflowTaskCompletionView(presentation.view)
    && (presentation.continuation === "next-task" || presentation.continuation === "awaiting-replan")) {
    return {
      ok: true,
      value: {
        kind: "task-completion",
        view: presentation.view,
        continuation: presentation.continuation,
      },
    };
  }
  if (presentation.kind === "workflow-completion" && isWorkflowCompletionView(presentation.view)) {
    return { ok: true, value: { kind: "workflow-completion", view: presentation.view } };
  }
  return invalidPresentation("INVALID", "展示记录类型或字段无效，保留原始工具文本");
}
