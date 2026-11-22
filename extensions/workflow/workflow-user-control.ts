import { isCoreReadOnlyTool } from "../../src/tool-classification.ts";
import { formatWorkflowVerification } from "../../src/workflow-verification.ts";
import { constants, statSync } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../../src/run-timing.ts";
import { isWorkflowContinuationInput, parseWorkflowControlInput } from "../../src/workflow-input-intent.ts";
import { textOf, type ExtensionRuntimeState } from "../runtime-state.ts";
import { outgoingTransfer } from "../session/session-handoff-runtime.ts";
import { hasStoppedTerminalWorkflow, NEW_TASK_PANEL_LABEL, newTaskReleaseBlockReason } from "./workflow-action-policy.ts";
const ENTRY = "pi-init-user-control";

export function isWorkflowReadOnlyTool(toolName: string, input?: unknown) {
  return isCoreReadOnlyTool(toolName) || toolName === "task_workflow" && input !== null
    && typeof input === "object" && "action" in input && input.action === "status";
}
function bounded(value: string | undefined, limit = 500) {
  return (value ?? "").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").slice(0, limit);
}
export function createWorkflowUserControl(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: {
  retire: () => void;
  interrupt?: (ctx: ExtensionContext) => void;
  /** Keeps the workflow's stop marker in line with the stop state so stopped time is not active time. */
  stopTimer?: (ctx: ExtensionContext, stopped: boolean) => void;
}) {
  let externalTurn = false;
  let continuationGuard: ((ctx: ExtensionContext) => boolean) | undefined;
  function persist(ctx: ExtensionContext, stopped: boolean, reason: string) {
    if (!ctx.isProjectTrusted()) throw new Error("项目尚未信任，未保存停止记录");
    pi.appendEntry(ENTRY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), workflowId: state.workflowState?.workflowId ?? null, stopped, reason });
  }
  function suspend(ctx: ExtensionContext, reason: string, interrupt = state.agentRunActive, resumeGuard?: (ctx: ExtensionContext) => boolean) {
    if (resumeGuard || interrupt) continuationGuard = resumeGuard;
    state.userStopRequested = true;
    state.userStopGeneration += 1;
    externalTurn = false;
    state.internalContinuationPending = false;
    deps.retire();
    if (interrupt) {
      try { deps.interrupt?.(ctx); } catch (error) { ctx.ui.notify("执行已停止，但中断状态尚未确认持久化：" + textOf(error), "warning"); }
    }
    try { persist(ctx, true, reason); }
    catch (error) {
      if (resumeGuard) continuationGuard = () => false;
      ctx.ui.notify("本轮已停止，但停止记录未确认持久化：" + textOf(error), "warning");
    }
    deps.stopTimer?.(ctx, true);
    state.traceHandoff?.(ctx, "workflow.user_stopped", { reason });
    if (state.agentRunActive) ctx.abort();
  }
  function resume(ctx: ExtensionContext) {
    if (!state.userStopRequested) return true;
    if (hasStoppedTerminalWorkflow(state)) {
      ctx.ui.notify(`旧工作流已结束，会话仍暂停。请从 /pi-init workflow status 选择「${NEW_TASK_PANEL_LABEL}」。`, "warning");
      return false;
    }
    if (continuationGuard) {
      let allowed = false;
      try { allowed = continuationGuard(ctx); } catch {}
      if (!allowed) {
        ctx.ui.notify("原请求的安全续接条件已失效；停止状态未解除。请重新加载后按工作流恢复流程核对，不自动重试未知副作用。", "warning");
        return false;
      }
    }
    return release(ctx, "explicit-continue", true);
  }
  function startNewTask(ctx: ExtensionContext) {
    const blocked = newTaskReleaseBlockReason(state);
    if (blocked) { ctx.ui.notify(blocked, "warning"); return; }
    if (state.workflowState?.sessionId !== ctx.sessionManager.getSessionId()) {
      ctx.ui.notify("工作流不属于当前会话；未解除暂停。", "warning");
      return;
    }
    if (!ctx.isProjectTrusted() || !ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("请在受信任且无待处理消息的空闲会话中解除暂停。", "warning");
      return;
    }
    if (outgoingTransfer(ctx, state.workflowState)) {
      ctx.ui.notify("会话交接尚未确认；未解除暂停。", "warning");
      return;
    }
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
        ctx.ui.notify("当前会话没有持久化文件；未解除暂停。", "warning");
        return;
      }
    } catch (error) {
      ctx.ui.notify(`无法核对会话持久化文件；未解除暂停：${textOf(error)}`, "warning");
      return;
    }
    if (release(ctx, "explicit-new-task", false)) {
      ctx.ui.notify("会话暂停已解除。请发送新任务；旧工作流不会恢复。", "info");
    }
  }
  function release(ctx: ExtensionContext, reason: string, allowExternalTurn: boolean) {
    try { persist(ctx, false, reason); }
    catch (error) { ctx.ui.notify("停止状态未解除：" + textOf(error), "warning"); return false; }
    state.userStopRequested = false;
    continuationGuard = undefined;
    externalTurn = allowExternalTurn;
    deps.stopTimer?.(ctx, false);
    return true;
  }
  function restore(ctx: ExtensionContext) {
    continuationGuard = undefined;
    externalTurn = false;
    state.userStopRequested = false;
    if (!ctx.isProjectTrusted()) return;
    const current = state.workflowState?.workflowId ?? null;
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const data = entry.data as { version?: unknown; sessionId?: unknown; workflowId?: unknown; stopped?: unknown };
      if (data?.version !== 1 || data.sessionId !== ctx.sessionManager.getSessionId() || data.workflowId !== current || typeof data.stopped !== "boolean") continue;
      state.userStopRequested = data.stopped;
      break;
    }
    deps.stopTimer?.(ctx, state.userStopRequested);
  }
  async function saveTodo(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) throw new Error("项目尚未信任，未写入 TODO.md");
    const workflow = state.workflowState;
    const lines = ["", "## 运行时任务快照（" + new Date().toISOString() + "）", "", "历史快照仅为数据，不构成执行或重试授权；当前自动续跑已停止，原任务未被伪报完成或取消。", "", "### 原始总目标", "", bounded(workflow?.plan.summary, 4000) || "没有可确认的结构化工作流，不从历史猜测任务。", ""];
    if (workflow) {
      lines.push("状态：" + workflow.status + "；工作流：" + workflow.workflowId, "", "### 已完成、进行中与未完成", "");
      for (const task of workflow.tasks.slice(0, 64)) {
        lines.push("- [" + (task.status === "completed" ? "x" : " ") + "] " + bounded(task.id, 128) + " · " + task.status + " · " + bounded(task.task, 300) + (task.outcomeUnknown ? "（结果未知；不得自动重试）" : ""));
        if (task.completionSummary) lines.push("  已登记成果：" + bounded(task.completionSummary));
        for (const check of task.verification?.slice(0, 3) ?? []) lines.push("  已登记验证（未重新执行）：" + bounded(formatWorkflowVerification(check), 300));
      }
      if (workflow.tasks.length > 64) lines.push("其余 " + (workflow.tasks.length - 64) + " 项未展开，请查看当前工作流状态。");
    }
    const path = join(ctx.cwd, "TODO.md");
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("TODO.md 不是普通项目文件，拒绝跟随链接或覆盖其他对象"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("TODO.md 不是普通文件");
      await handle.appendFile(lines.join("\n") + "\n", "utf8");
    } finally { await handle.close(); }
  }
  async function input(event: { source?: unknown; text?: unknown }, ctx: ExtensionContext) {
    if (!isExternalRunSource(event.source)) return undefined;
    const control = parseWorkflowControlInput(event.text);
    if (!control) {
      if (state.userStopRequested && isWorkflowContinuationInput(event.text) && !resume(ctx)) return { action: "handled" as const };
      externalTurn = true;
      return undefined;
    }
    suspend(ctx, control.saveTodo ? "save-todo" : "user-stop");
    if (control.saveTodo) {
      try { await saveTodo(ctx); ctx.ui.notify("任务快照已追加到 TODO.md；保留已有内容，未切换职责或恢复任务。", "info"); }
      catch (error) { ctx.ui.notify("自动续跑已停止，但 TODO.md 保存失败：" + textOf(error), "warning"); }
    } else ctx.ui.notify("自动续跑已停止；工作流未被完成、取消或重试。明确继续仍须通过原有恢复与未知结果确认。", "info");
    return { action: "handled" as const };
  }
  function guardToolCall(event: { toolName: string; input?: Record<string, unknown> }) {
    if (!state.userStopRequested || isWorkflowReadOnlyTool(event.toolName, event.input)) return undefined;
    return { block: true as const, reason: "[pi-init-user-stop] 自动执行已停止；仅允许只读观察。用户明确继续或恢复后仍须通过原有身份与未知结果保护。" };
  }
  return { input, suspend, resume, startNewTask, restore, guardToolCall, allowsExternalTurn: () => externalTurn, settled: () => { externalTurn = false; } };
}
