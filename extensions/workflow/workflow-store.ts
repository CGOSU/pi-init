import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_RECOVERY_DISPOSITION_TYPE,
  parseWorkflowRecoveryDisposition,
} from "../../src/workflow-recovery-disposition.ts";
import { textOf, type ExtensionRuntimeState, type WorkflowState } from "../runtime-state.ts";

export type WorkflowStoreDependencies = {
  pi: Pick<ExtensionAPI, "appendEntry">;
  onWorkflowPersisted?: (workflow: WorkflowState, ctx: ExtensionContext) => void;
  traceWorkflowPersisted?: (ctx: ExtensionContext) => void;
  updateWorkflowStatus?: (ctx: ExtensionContext) => void;
};

export function createWorkflowStore(
  state: Pick<ExtensionRuntimeState, "workflowState" | "workflowRestoreError">,
  deps: WorkflowStoreDependencies,
) {
  function afterCommit(stage: string, effect: () => void, ctx: ExtensionContext) {
    try {
      effect();
    } catch (error) {
      // The append already succeeded. Even a broken notification sink must not
      // turn this into a failed commit or cause a completed task to be replayed.
      try {
        ctx.ui.notify(`工作流结果已保存，但${stage}失败：${textOf(error)}；不会重放已完成任务。`, "warning");
      } catch {
        // Auxiliary reporting cannot roll back a committed result.
      }
    }
  }

  function persistWorkflowState(next: WorkflowState, ctx: ExtensionContext) {
    deps.pi.appendEntry("pi-init-workflow", next);
    state.workflowState = next;
    state.workflowRestoreError = undefined;
    afterCommit("进展观察同步", () => deps.onWorkflowPersisted?.(next, ctx), ctx);
    afterCommit("诊断记录", () => deps.traceWorkflowPersisted?.(ctx), ctx);
    afterCommit("状态展示更新", () => deps.updateWorkflowStatus?.(ctx), ctx);
    return next;
  }

  // Only the recovery loader installs a snapshot read from the current branch.
  // Business transitions use persistWorkflowState, never this hydration path.
  function restoreSnapshot(snapshot: WorkflowState | undefined) {
    state.workflowState = snapshot;
  }

  function persistWorkflowRecoveryDisposition(input: unknown) {
    const parsed = parseWorkflowRecoveryDisposition(input);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.error.message), { code: parsed.error.code });
    }
    try {
      deps.pi.appendEntry(WORKFLOW_RECOVERY_DISPOSITION_TYPE, parsed.value);
    } catch (error) {
      throw Object.assign(
        new Error(`无法持久化工作流恢复隔离处置：${textOf(error)}`),
        { code: "WORKFLOW_RECOVERY_DISPOSITION_PERSIST_FAILED" },
      );
    }
    return parsed.value;
  }

  return { persistWorkflowState, persistWorkflowRecoveryDisposition, restoreSnapshot };
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;
