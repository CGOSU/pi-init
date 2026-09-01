import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getWorkflowTask } from "../src/workflow.js";
import { SUBTASK_RESULT_PROTOCOL } from "../src/subtask.js";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { textOf } from "./runtime-state.ts";

export type WorkflowMessageDependencies = {
  pi: ExtensionAPI;
  setInternalContinuationPending: (value: boolean) => void;
};

export function createWorkflowMessages(
  state: ExtensionRuntimeState,
  deps: WorkflowMessageDependencies,
) {
  function workflowTaskPrompt(taskId: string, note?: string) {
    const workflowState = state.workflowState;
    if (!workflowState) throw new Error("当前没有活动工作流");
    const task = getWorkflowTask(workflowState, taskId);
    if (!task) throw new Error(`工作流任务不存在：${taskId}`);
    const completed = workflowState.tasks
      .filter((item) => item.status === "completed")
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}`);

    return [
      "[PI-INIT 自动任务工作流]",
      `工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `已完成任务：\n${completed.join("\n")}` : "",
      `当前任务（${task.id}，角色 ${task.role}）：${task.task}`,
      `允许涉及的文件或目录：${task.files.join(", ")}`,
      `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      note ? `调度提示：${note}` : "",
      "读取策略：复用当前上下文中已注入或本会话已读取且未失效的证据，不为确认已知事实重复读取。只有位置、实现、影响或新鲜度不确定时才按需读取：已知证据 0 轮，局部缺口 1 轮，未知位置或新符号/配置/调用链通常最多 2 轮；验证失败只读取报错位置及必要的一层直接调用方。安全、认证、公共 API、数据迁移、并发、删除或可能被其他协作者修改的工作区必须检查最新实现、调用方和测试；低风险已有精确唯一 oldText 可直接 edit，匹配失败后再最小读取。",
      "精确编辑策略：首次缺少新鲜目标内容时先 read；一次 edit 成功后，若期间没有可能写入目标文件的命令、工具、Git 操作或外部协作者修改，可在当前上下文复用已确定的 oldText → newText 结果作为逻辑快照，不生成缓存文件或持久状态。若 exact-text 因 oldText 零匹配失败，只能最小范围重读，重新确认修改意图和唯一精确 oldText，最多 retry 一次；不得模糊匹配、正则替换或仅凭行号猜测，歧义、其他错误或第二次失败立即停止。",
      "如果用户在本工作流期间提出会改变后续方向或新增后续工作的普通描述，不要自行派发旧计划的下一任务；扩展会先记录重规划请求，当前任务完成后交给架构师重规划。若必须立即停止当前任务，使用现有 cancel 流程。",
      "除非遇到真正阻塞的需求、权限、凭据、破坏性操作或必须由用户决定的产品取舍，不要询问用户；做合理假设并记录。",
      `完成并实际验证后，必须调用 task_workflow(action="complete", taskId="${task.id}", completionSummary=..., implementationRationale=..., verification=[...])。implementationRationale 说明为什么采用该实现及关键取舍，不要重复 completionSummary；verification 只能填写实际执行过的命令和结果。若无法继续，调用 task_workflow(action="block", taskId="${task.id}", reason=...)，不要伪造完成。`,
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowTaskMessage(ctx: ExtensionContext, taskId: string, note?: string) {
    if (!state.workflowState || state.workflowState.currentTaskId !== taskId) return;
    state.workflowDispatchInFlight = false;
    try {
      deps.setInternalContinuationPending(true);
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-task",
          content: workflowTaskPrompt(taskId, note),
          display: false,
          details: { taskId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      deps.setInternalContinuationPending(false);
      ctx.ui.notify(`无法自动进入任务 ${taskId}：${textOf(error)}`, "error");
    }
  }

  function workflowReplanPrompt() {
    const workflowState = state.workflowState;
    const request = workflowState?.pendingRevision;
    if (!workflowState || !request) throw new Error("工作流缺少待处理的重规划请求");
    const completed = workflowState.tasks
      .filter((item) => item.status === "completed")
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}`);
    const pending = workflowState.tasks
      .filter((item) => item.status === "pending")
      .map((item) => `- ${item.id}: ${item.task}；依赖：${item.dependsOn.join(", ") || "无"}`);

    return [
      "[PI-INIT 工作流重规划]",
      `工作流当前 revisionId：${request.revisionId}`,
      `用户新增方向或需求（按提交顺序合并的全部指令）：\n${request.direction.split("\n").map((item) => `- ${item}`).join("\n")}`,
      `当前工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `原架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `已完成任务（不可修改）：\n${completed.join("\n")}` : "",
      pending.length > 0 ? `旧计划中尚未开始的任务：\n${pending.join("\n")}` : "无旧的未开始任务",
      "规划读取策略：复用当前上下文中已注入或本会话已读取且未失效的证据，不为确认已知事实重复读取。只为解决位置、实现、影响或新鲜度不确定性读取最小范围：已知证据 0 轮，局部缺口 1 轮，未知位置或新符号/配置/调用链通常最多 2 轮；验证失败只读取报错位置及必要的一层直接调用方。安全、认证、公共 API、数据迁移、并发、删除或可能被其他协作者修改的工作区必须检查最新实现、调用方和测试。",
      "请只规划未完成的后续工作；不要修改已完成任务的摘要或验证记录。",
      "若只是新增后续工作，把仍有效的旧任务 ID 放入 retainTaskIds；新增 tasks 必须使用从未出现过的新 ID。若替换旧任务，不要把被替换任务 ID 放进新 tasks，也不要让新任务依赖被替换任务。",
      `规划完成后，必须调用 task_workflow(action="replan", revisionId="${request.revisionId}", summary=..., constraints=[...], tasks=[...], retainTaskIds=[...])。只有架构角色可以提交该动作。`,
      "不要调用 complete、block 或 cancel 来代替 replan；如果无法形成可靠的新计划，说明真正阻塞原因并保持当前重规划状态。",
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowReplanMessage(ctx: ExtensionContext) {
    const workflowState = state.workflowState;
    if (!workflowState || workflowState.status !== "replanning" || !workflowState.pendingRevision) return;
    state.workflowDispatchInFlight = false;
    try {
      deps.setInternalContinuationPending(true);
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-replan",
          content: workflowReplanPrompt(),
          display: false,
          details: { revisionId: workflowState.pendingRevision.revisionId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      deps.setInternalContinuationPending(false);
      ctx.ui.notify(`无法自动进入架构重规划：${textOf(error)}`, "error");
    }
  }

  function workflowSubtaskPrompt(taskId: string) {
    const workflowState = state.workflowState;
    if (!workflowState) throw new Error("当前没有活动工作流");
    const task = getWorkflowTask(workflowState, taskId);
    if (!task) throw new Error(`工作流任务不存在：${taskId}`);
    const completed = workflowState.tasks
      .filter((item) => item.status === "completed")
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}`);

    return [
      "[PI-INIT SUBTASK WORKFLOW]",
      `Workflow goal: ${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `Architecture constraints:\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `Completed tasks:\n${completed.join("\n")}` : "",
      `Current task (${task.id}, role ${task.role}): ${task.task}`,
      `Allowed files or directories: ${task.files.join(", ")}`,
      `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      "Read policy: reuse evidence already injected or read in this session while it remains fresh; do not reread merely to confirm known facts. Read only to resolve location, implementation, impact, or freshness uncertainty: use 0 rounds for sufficient evidence, 1 for a local gap, and usually at most 2 for an unknown location or new symbol/configuration/call chain; parallelize reads within a round. Verification failures require reading the error location and only necessary direct callers. Security, authentication, public API, migration, concurrency, deletion, or a worktree another collaborator may change requires checking the latest implementation, callers, and tests. For low-risk work, an exact unique oldText may be edited directly and reread only after a match failure.",
      "Exact-edit policy: read the target when fresh content is missing; after a successful edit, if no command, tool, Git operation, or external collaborator may have written the target, reuse the confirmed oldText -> newText result as a logical snapshot in the current context; do not create cache files or persistent state. If exact-text editing fails because oldText has zero matches, reread the smallest relevant range, re-confirm the intent and a unique exact oldText, and retry at most once. Never use fuzzy or regex matching or guess from line numbers; stop on ambiguity, other errors, or a second failure.",
      "Work in the current shared checkout. Do not create worktrees, merge branches, commit, or push.",
      "Do not call pi-init task_workflow tools. The parent session owns workflow state.",
      "If the user describes a changed direction or new follow-up work, do not dispatch or assume any old next task; the parent session records the request and waits for the Architect at the task boundary.",
      `When finished, output only one JSON object using protocol ${SUBTASK_RESULT_PROTOCOL}. For success use {"protocol":"${SUBTASK_RESULT_PROTOCOL}","outcome":"complete","completionSummary":"...","implementationRationale":"why this implementation was chosen and its key trade-offs","verification":["actual command and result"]}. If genuinely blocked use {"protocol":"${SUBTASK_RESULT_PROTOCOL}","outcome":"blocked","reason":"..."}. Do not wrap it in Markdown fences or add other text.`,
    ].filter(Boolean).join("\n\n");
  }

  function sendSubtaskDispatchMessage(ctx: ExtensionContext, taskId: string) {
    if (!state.workflowState || state.workflowState.currentTaskId !== taskId) return;
    state.workflowDispatchInFlight = false;
    try {
      deps.setInternalContinuationPending(true);
      deps.pi.sendMessage(
        {
          customType: "pi-init-subtask-dispatch",
          content: [
            "请调用 subtask 工具派发当前工作流任务。",
            "subtask 工具的 task 参数必须原样使用下面整段文本（逐字不变，不要改写、截断或概括）：",
            "",
            workflowSubtaskPrompt(taskId),
            "",
            "调用 subtask 工具后立即结束当前回合：不要自行执行该任务，不要等待或轮询结果，不要调用 task_workflow。subtask 完成后其结果会自动回到本会话，工作流会自动推进到下一步。",
          ].join("\n"),
          display: false,
          details: { taskId },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      deps.setInternalContinuationPending(false);
      ctx.ui.notify(`无法派发 subtask 任务 ${taskId}：${textOf(error)}`, "error");
    }
  }

  return {
    workflowTaskPrompt,
    sendWorkflowTaskMessage,
    workflowReplanPrompt,
    sendWorkflowReplanMessage,
    workflowSubtaskPrompt,
    sendSubtaskDispatchMessage,
  };
}

export type WorkflowMessages = ReturnType<typeof createWorkflowMessages>;
