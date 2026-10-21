import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isExternalRunSource } from "../src/run-timing.ts";
import { isWorkflowContinuationInput, parseWorkflowControlInput } from "../src/workflow-input-intent.ts";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
const ENTRY = "pi-init-user-control";
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
function bounded(value: string | undefined, limit = 500) {
  return (value ?? "").replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").slice(0, limit);
}
export function createWorkflowUserControl(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: { retire: () => void; interrupt?: (ctx: ExtensionContext) => void }) {
  let externalTurn = false;
  function persist(ctx: ExtensionContext, stopped: boolean, reason: string) {
    if (!ctx.isProjectTrusted()) throw new Error("项目尚未信任，未保存停止记录");
    pi.appendEntry(ENTRY, { version: 1, sessionId: ctx.sessionManager.getSessionId(), workflowId: state.workflowState?.workflowId ?? null, stopped, reason });
  }
  function suspend(ctx: ExtensionContext, reason: string) {
    state.userStopRequested = true;
    externalTurn = false;
    state.internalContinuationPending = false;
    deps.retire();
    if (state.agentRunActive) {
      try { deps.interrupt?.(ctx); } catch (error) { ctx.ui.notify("执行已停止，但中断状态尚未确认持久化：" + textOf(error), "warning"); }
    }
    try { persist(ctx, true, reason); }
    catch (error) { ctx.ui.notify("本轮已停止，但停止记录未确认持久化：" + textOf(error), "warning"); }
    state.traceHandoff?.(ctx, "workflow.user_stopped", { reason });
    if (state.agentRunActive) ctx.abort();
  }
  function resume(ctx: ExtensionContext) {
    if (!state.userStopRequested) return true;
    try { persist(ctx, false, "explicit-continue"); }
    catch (error) { ctx.ui.notify("停止状态未解除：" + textOf(error), "warning"); return false; }
    state.userStopRequested = false;
    externalTurn = true;
    return true;
  }
  function restore(ctx: ExtensionContext) {
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
      return;
    }
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
        for (const check of task.verification?.slice(0, 3) ?? []) lines.push("  已登记验证（未重新执行）：" + bounded(check, 300));
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
    if (!state.userStopRequested || READ_ONLY.has(event.toolName) || event.toolName === "task_workflow" && event.input?.action === "status") return undefined;
    return { block: true as const, reason: "[pi-init-user-stop] 自动执行已停止；仅允许只读观察。用户明确继续或恢复后仍须通过原有身份与未知结果保护。" };
  }
  return { input, suspend, resume, restore, guardToolCall, allowsExternalTurn: () => externalTurn, settled: () => { externalTurn = false; } };
}
