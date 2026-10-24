import { getNextWorkflowTask, isWorkflowActive, workflowActionIdentity } from "../src/workflow.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

export function buildHandoffSnapshot(state: ExtensionRuntimeState, role: string) {
  const workflow = state.workflowState;
  const active = workflow && isWorkflowActive(workflow) ? workflow : undefined;
  const task = active?.tasks.find(item => item.id === active.currentTaskId) ?? (active ? getNextWorkflowTask(active) : undefined);
  return { role, workflow: active ? { ...workflowActionIdentity(active), status: active.status, taskId: task?.id, taskStatus: task?.status,
    verificationRefs: active.tasks.filter(item => item.verification?.length).slice(-4).map(item => item.id) } : undefined,
    nextAction: active ? '按当前任务继续；缺少详情时调用 task_workflow(action="status")，不重做已完成工作。' : "继续用户目标中尚未完成的工作；没有待办就结束，不创造新任务。" };
}

export function handoffSnapshotPrompt(state: ExtensionRuntimeState, role: string) {
  return [
    "系统生成的轻量交接快照（引用按需读取，不代表任务完成或证据已接受）：",
    JSON.stringify(buildHandoffSnapshot(state, role)),
    "涉及调查时，从当前用户请求、任务和已有事实明确用户目标、被调查对象、非目标及结论依据；只补关键缺口，不要求新建记录、工作流或逐次搜索审批。",
    "调查对象与记录/存储路径分开：当前工作区不自动等于被调查项目，来源路径只是优先线索，不是硬白名单；执行角色可沿直接相关线索自主扩展，对象未知时定向核实，不靠猜测补齐，未命中不能证明未发生。",
    "换角时复用仍适用的事实并区分已观察、推断和未确认；来源变化或关键依据不足时才定向补查，不为交接重读整批历史或增加模型往返。此边界提示不授予执行权限，不替代职责恢复门，architect 仍不得读取、执行或连接 MCP。",
    "补充说明可省略；引用失效或证据不足时，先读取当前状态并补查、补证或验证，不猜测旧身份，不因说明缺失请求人类。只有权限、凭据、破坏性操作或必须由用户决定的产品取舍才请求人类；持久化和身份安全检查仍须遵守。",
  ].join("\n");
}
