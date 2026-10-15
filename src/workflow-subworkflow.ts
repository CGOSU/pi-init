import { cloneState, normalizeTextList, requireText, requireTimestamp } from "./workflow-model.ts";
import type { WorkflowState, WorkflowSubworkflowContract, WorkflowSubworkflowReview, WorkflowSubworkflowSummary, WorkflowTask } from "./workflow-types.ts";
import path from "node:path";

export function normalizeSubworkflowContract(value: unknown): WorkflowSubworkflowContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("子流程必须提供输入、输出、验收和副作用范围契约");
  const input = value as Record<string, unknown>;
  const allowedFiles = normalizeTextList(input.allowedFiles, "子流程契约 allowedFiles", { required: true });
  allowedFiles.forEach(normalizeSubworkflowFile);
  return {
    inputs: normalizeTextList(input.inputs, "子流程契约 inputs", { required: true }),
    expectedOutputs: normalizeTextList(input.expectedOutputs, "子流程契约 expectedOutputs", { required: true }),
    acceptanceCriteria: normalizeTextList(input.acceptanceCriteria, "子流程契约 acceptanceCriteria", { required: true }),
    allowedFiles,
  };
}

export function normalizeSubworkflowReview(value: unknown): WorkflowSubworkflowReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("子流程结果审阅格式无效");
  const input = value as Record<string, unknown>;
  if ((input.decision !== "continue" && input.decision !== "replan" && input.decision !== "block") || typeof input.parentPlanValid !== "boolean") throw new Error("子流程审阅必须明确决定与父计划有效性");
  return {
    childWorkflowId: requireText(input.childWorkflowId, "子流程审阅 childWorkflowId"),
    decision: input.decision as WorkflowSubworkflowReview["decision"],
    parentPlanValid: input.parentPlanValid,
    reason: requireText(input.reason, "子流程结果与父计划影响核查依据"),
    acceptedOutputs: normalizeTextList(input.acceptedOutputs, "已接受的子流程输出"),
    verification: normalizeTextList(input.verification, "子流程结果实际验证", { required: true }),
    reviewedAt: requireTimestamp(input.reviewedAt, "子流程审阅时间"),
  };
}

export function reviewReturnedSubworkflow(state: WorkflowState, input: unknown, now: number): WorkflowState {
  if (state.status !== "replanning" || state.pauseReason !== "child-result-review" || !state.pendingRevision) throw new Error("当前没有等待验收的子流程结果");
  const review = normalizeSubworkflowReview({ ...(input as object), reviewedAt: now });
  const child = state.subworkflowHistory?.findLast((entry) => entry.parentWorkflowId === state.workflowId);
  if (!child || child.workflowId !== review.childWorkflowId) throw new Error("子流程结果身份已变化，不接受旧结果审阅");
  assertSubworkflowReview(child, review);
  const next = cloneState(state, now);
  const result = next.subworkflowHistory!.findLast((entry) => entry.parentWorkflowId === next.workflowId)!;
  result.reviews = [...(result.reviews ?? []), review];
  if (review.decision !== "continue") {
    next.taskPauseReason = review.decision === "block" ? review.reason : undefined;
    if (review.decision === "block") next.status = "paused";
    return next;
  }
  const revision = next.revisions.find((entry) => entry.revisionId === next.pendingRevision!.revisionId)!;
  revision.status = "applied";
  revision.appliedAt = now;
  delete next.pendingRevision;
  delete next.pauseReason;
  delete next.taskPauseReason;
  next.recoveryGeneration += 1;
  next.status = next.tasks.every((task) => task.status === "completed" || task.status === "superseded") ? "completed" : "running";
  if (next.status === "completed") {
    next.completedAt = now;
    delete next.continuation;
  } else {
    next.continuation = { kind: "schedule", phase: "pending", reason: "child-completed" };
  }
  return next;
}

export function normalizeSubworkflowFile(file: string): string {
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || /^[a-z]:/iu.test(normalized) || normalized === ".." || normalized.startsWith("../")) throw new Error("子流程范围必须是项目内相对路径");
  return normalized;
}

export function assertSubworkflowTaskScope(contract: WorkflowSubworkflowContract, tasks: WorkflowTask[]): void {
  const allowed = contract.allowedFiles.map(normalizeSubworkflowFile);
  for (const task of tasks) {
    for (const file of task.files) {
      const normalized = normalizeSubworkflowFile(file);
      if (!allowed.some((base) => base === "." || normalized === base || normalized.startsWith(`${base}/`))) throw new Error(`子流程任务 ${task.id} 的文件 ${file} 超出 allowedFiles 契约范围`);
    }
  }
}

export function assertSubworkflowReview(child: WorkflowSubworkflowSummary, review: WorkflowSubworkflowReview): void {
  if (review.childWorkflowId !== child.workflowId) throw new Error("子流程结果身份已变化");
  if (review.decision === "continue" && (child.status !== "completed" || !child.contract || !review.parentPlanValid
    || !child.contract.expectedOutputs.every((output) => review.acceptedOutputs.includes(output))
    || child.tasks.some((task) => task.status !== "completed" || task.outcomeUnknown || !task.verification?.length))) {
    throw new Error("子流程未满足输出契约、验证或父计划有效性；取消/未知结果不能直接继续父计划，请 replan 或 block");
  }
}
