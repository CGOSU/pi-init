import type { WorkflowHandoffIdentity } from "../src/workflow-types.ts";

const TASK_MESSAGE_TYPE = "pi-init-workflow-task";
const IDENTITY_FIELDS = [
  "workflowId",
  "planVersion",
  "sessionId",
  "recoveryGeneration",
  "taskId",
  "attemptId",
  "handoffId",
] as const;

type IdentityField = typeof IDENTITY_FIELDS[number];

export type WorkflowTaskStartEvidenceResult =
  | { ok: true; value: WorkflowHandoffIdentity }
  | { ok: false; code: string; message: string; field?: IdentityField };

function failure(code: string, message: string, field?: IdentityField): WorkflowTaskStartEvidenceResult {
  return { ok: false, code, message, ...(field ? { field } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkflowTaskStartMessage(
  message: unknown,
  expected: WorkflowHandoffIdentity,
): WorkflowTaskStartEvidenceResult {
  if (!isRecord(message)) return failure("WORKFLOW_TASK_MESSAGE_INVALID", "工作流任务消息必须是对象");
  if (message.role !== "custom") return failure("WORKFLOW_TASK_MESSAGE_ROLE_INVALID", "启动证据必须来自 custom 消息");
  if (message.customType !== TASK_MESSAGE_TYPE) return failure("WORKFLOW_TASK_MESSAGE_TYPE_INVALID", "消息不是当前工作流任务类型");
  if (!isRecord(message.details)) return failure("WORKFLOW_TASK_MESSAGE_DETAILS_INVALID", "工作流任务消息 details 必须是对象");

  const details = message.details;
  for (const field of IDENTITY_FIELDS) {
    if (!Object.hasOwn(details, field)) {
      return failure("WORKFLOW_HANDOFF_IDENTITY_FIELD_MISSING", `工作流任务消息缺少身份字段 ${field}`, field);
    }
    const value = details[field];
    if (field === "planVersion" || field === "recoveryGeneration") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        return failure("WORKFLOW_HANDOFF_IDENTITY_FIELD_INVALID", `工作流任务消息身份字段 ${field} 必须是非负安全整数`, field);
      }
    } else if (typeof value !== "string" || value.trim().length === 0) {
      return failure("WORKFLOW_HANDOFF_IDENTITY_FIELD_INVALID", `工作流任务消息身份字段 ${field} 必须是非空文本`, field);
    }
    if (value !== expected[field]) {
      return failure("WORKFLOW_TASK_MESSAGE_IDENTITY_STALE", `工作流任务消息身份已变化：${field}`, field);
    }
  }

  return {
    ok: true,
    value: {
      workflowId: details.workflowId as string,
      planVersion: details.planVersion as number,
      sessionId: details.sessionId as string,
      recoveryGeneration: details.recoveryGeneration as number,
      taskId: details.taskId as string,
      attemptId: details.attemptId as string,
      handoffId: details.handoffId as string,
    },
  };
}
