import {
  WORKFLOW_RECOVERY_DISPOSITION_TYPE,
  workflowRecoveryDispositionMatches,
} from "../src/workflow-recovery-disposition.ts";

type WorkflowRecoverySource = {
  index: number;
  entry?: Record<string, unknown>;
  entryId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function latestWorkflowRecoverySource(branch: readonly unknown[]): WorkflowRecoverySource {
  const index = branch.findLastIndex((entry) => isRecord(entry)
    && entry.type === "custom"
    && entry.customType === "pi-init-workflow");
  const entry = index < 0 ? undefined : branch[index];
  const source = isRecord(entry) ? entry : undefined;
  const entryId = typeof source?.id === "string"
    && source.id.trim()
    && source.id === source.id.trim()
    && source.id.length <= 256
    ? source.id
    : undefined;
  return { index, ...(source ? { entry: source } : {}), ...(entryId ? { entryId } : {}) };
}

export function workflowRestoreErrorForSource(
  error: { code: string; message: string },
  branch: readonly unknown[],
  source: WorkflowRecoverySource,
  sessionId: unknown,
) {
  if (source.index >= 0 && source.entryId && typeof sessionId === "string" && sessionId) {
    for (let index = source.index + 1; index < branch.length; index += 1) {
      const entry = branch[index];
      if (!isRecord(entry) || entry.type !== "custom"
        || entry.customType !== WORKFLOW_RECOVERY_DISPOSITION_TYPE
        || !Object.prototype.hasOwnProperty.call(entry, "data")) continue;
      const matches = workflowRecoveryDispositionMatches(entry.data, {
        sessionId,
        sourceEntryId: source.entryId,
        sourceErrorCode: error.code,
      });
      if (matches.ok && matches.value) return undefined;
    }
  }
  return {
    code: error.code,
    message: error.message,
    ...(source.entryId ? { sourceEntryId: source.entryId } : {}),
  };
}

export type { WorkflowRecoverySource };
