import { hasOwn, isRecord } from "../src/value-guards.ts";
import {
  WORKFLOW_RECOVERY_DISPOSITION_TYPE,
  workflowRecoveryDispositionMatches,
} from "../src/workflow-recovery-disposition.ts";

type WorkflowRecoverySource = {
  index: number;
  entry?: Record<string, unknown>;
  entryId?: string;
};

export function latestWorkflowRecoverySource(branch: readonly unknown[]): WorkflowRecoverySource {
  const index = branch.findLastIndex((entry) => isRecord(entry)
    && entry.type === "custom"
    && (entry.customType === "pi-init-workflow" || entry.customType === "pi-init-coordination"));
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
        || !hasOwn(entry, "data")) continue;
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
