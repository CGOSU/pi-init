import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ARCHITECT_ALLOWED_ACTIONS_TEXT } from "./architect-boundary.ts";
import {
  getWorkflowTask,
  markWorkflowTaskOutcomeUnknown,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import type {
  ExtensionRuntimeState,
  WorkflowHandoffIdentity,
  WorkflowReplanIdentity,
  WorkflowState,
} from "./runtime-state.ts";
import { textOf } from "./runtime-state.ts";
import { transitionWorkflowDispatch } from "../src/workflow-orchestrator.ts";
import { handoffSnapshotPrompt } from "./handoff-snapshot.ts";

const GENERIC_TASK_TOOL_GUIDANCE = "遵循职责与安全边界，只修改当前任务范围。关键需求、事实或权限缺失时用block说明阻塞；普通可逆工程细节自主处理。复用仍有效的调查和验证，如实报告结果，不重放未知副作用。";
const ARCHITECT_RUNTIME_GUIDANCE = `architect 不直接取证、不执行代码、不连接 MCP；只思考、分析、决策、规划和安排；运行时仅可调用 switch_role，以及 task_workflow 的 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}。已有调查与任务工作记忆可以复用；确需新事实时安排普通 docs-commit 调查任务，不建立正式证据协议。`;

function taskRoleGuidance(role: string) {
    if (role === "architect") return ARCHITECT_RUNTIME_GUIDANCE;
    const gitBoundary = "这是工作流子任务，不默认等同于整流程 Git 收尾；只为当前任务需要的改动归属、冲突、验收或真实提交检查最新 Git 状态，不为 complete 或填报告例行重复全仓 git status/git diff。已有归属和验证结论可交接，但编辑、共享工作区变化或提交前仍须必要刷新，不缓存旧 diff 冒充当前结果。";
    if (role === "docs-commit") {
      return "docs-commit 负责取证和文档/Git 收尾；交接事实与风险，不替 architect 做关键决策，也不修改代码。当前任务为取证或普通文档时不自动开展 Git 收尾；只有明确的 Git 验收或统一收尾任务才执行。" + gitBoundary;
    }
    return gitBoundary;
}

function taskToolGuidance(role: string) {
  return role === "architect"
    ? `${ARCHITECT_RUNTIME_GUIDANCE} 不得调用 read、grep、find、ls、ffgrep、fffind、browser、shell、edit、write、init_project、subtask、agent_message、MCP/mcpScript 或任何未知工具。`
    : GENERIC_TASK_TOOL_GUIDANCE;
}

function taskDirectionGuidance(role: string) {
  return "新目标只改变共享队列中的优先级与依赖，父子关系仅表达目标归属，不新建运行栈或自动恢复旧位置。讨论不修改计划。" + (role === "architect" ? "用 request-goal 显式安排目标，replan 提交新增任务并明确保留原有待执行任务；需修改原任务则走 request-replan。" : "当前任务在安全边界完成或正式上报阻塞后才重新调度；不要强行中断写操作，未知副作用不得自动重试。");
}

function taskCompletionGuidance(role: string) {
  if (role === "architect") return ARCHITECT_RUNTIME_GUIDANCE;
  return '阶段完成或验证结束后用task_workflow(checkpoint)登记成果与剩余工作；真实完成并验证后调用complete，提供completionSummary、implementationRationale和verification；可用evidenceIds引用本任务真实成功工具结果，已完成直接依赖的来源仅供只读历史复用，不证明当前版本或需求全部满足。确有阻塞用block。身份由运行时绑定，不重做已完成调查、不重放未知副作用。';
}

export type WorkflowMessageDependencies = {
  pi: ExtensionAPI;
  setInternalContinuationPending: (value: boolean) => void;
  persistWorkflowState: (next: WorkflowState, ctx: ExtensionContext) => WorkflowState;
};

export function createWorkflowMessages(
  state: ExtensionRuntimeState,
  deps: WorkflowMessageDependencies,
) {
  let lastContext: ExtensionContext | undefined;

  function workflowTaskPrompt(taskId: string, note?: string) {
    const workflowState = state.workflowState;
    if (!workflowState) throw new Error("当前没有活动工作流");
    const task = getWorkflowTask(workflowState, taskId);
    if (!task) throw new Error(`工作流任务不存在：${taskId}`);
    const identity = workflowHandoffIdentity(workflowState);
    if (!identity || identity.taskId !== taskId) throw new Error(`任务 ${taskId} 缺少活动交接身份`);
    const dependencyIds = new Set(task.dependsOn);
    const completed = workflowState.tasks
      .filter((item) => item.status === "completed" && dependencyIds.has(item.id))
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}${item.implementationRationale ? `；取舍：${item.implementationRationale}` : ""}${(item.verification ?? []).length ? `；验证：${(item.verification ?? []).join("；")}` : ""}${item.verificationEvidenceIds?.length ? `；历史验证来源ID（status可读，不证明当前版本）：${item.verificationEvidenceIds.join(", ")}` : ""}`);

    return [
      "[PI-INIT 自动任务工作流]",
      `工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `当前任务直接依赖成果：\n${completed.join("\n")}` : "",
      task.goalId ? `目标归属与约束（同一执行队列）：${JSON.stringify(workflowState.goals?.find(goal => goal.id === task.goalId))}` : "",
      `队列优先级：${task.priority ?? 0}；先满足依赖，再比较优先级。`,
      `当前任务（${task.id}，角色 ${task.role}）：${task.task}`,
      `当前任务：${task.id}；结果由运行时绑定本轮派发身份，不要手填身份或套用旧回合结果。`,
      `允许涉及的文件或目录：${task.files.join(", ")}`,
      `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      taskRoleGuidance(task.role),
      "围绕当前可验收交付物连续调查、实现和验证，不按操作步骤反复换角。一般技术选择自主决定，真实目标/边界偏差才重规划。",
      "验证按风险覆盖相关行为与失败边界；来源及配置未变时复用已有真实结果，不因文档修改或填写complete重跑全仓检查。命令和管道须保留被验证程序的真实退出码，不用最后echo/grep的成功掩盖失败。",
      note ? `调度提示：${note}` : "",
      taskToolGuidance(task.role),

      taskDirectionGuidance(task.role),
      "除非遇到真正阻塞的需求、权限、凭据、破坏性操作或必须由用户决定的产品取舍，不要询问用户；做合理假设并记录。",
      taskCompletionGuidance(task.role),
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowTaskMessage(
    ctx: ExtensionContext,
    taskId: string,
    note?: string,
    expectedIdentity?: WorkflowHandoffIdentity,
  ) {
    if (state.userStopRequested) return false;
    lastContext = ctx;
    const current = state.workflowState;
    const identity = current ? workflowHandoffIdentity(current) : undefined;
    if (!current || current.currentTaskId !== taskId || !identity
      || (expectedIdentity && !Object.keys(expectedIdentity).every((key) => identity[key as keyof WorkflowHandoffIdentity] === expectedIdentity[key as keyof WorkflowHandoffIdentity]))) {
      return false;
    }
    const type = current.handoff?.phase === "executing" ? "task-reminder-requested" : "task-dispatch-requested";
    const transition = transitionWorkflowDispatch(current, { type, identity }, Date.now());
    if (!transition.effects.length) return false;
    const firstDispatch = transition.state !== current;
    let dispatchAttempted = false;
    try {
      const content = [handoffSnapshotPrompt(state, getWorkflowTask(current, taskId)!.role), workflowTaskPrompt(taskId, note)].join("\n\n");
      if (firstDispatch) {
        deps.persistWorkflowState(transition.state, ctx);
      }
      deps.setInternalContinuationPending(true);
      dispatchAttempted = true;
      deps.pi.sendMessage(
        {
          customType: firstDispatch ? "pi-init-workflow-task" : "pi-init-workflow-continuation",
          content,
          display: false,
          details: identity,
        },
        { triggerTurn: true },
      );
      if (firstDispatch && state.workflowState) {
        const queued = transitionWorkflowDispatch(state.workflowState, { type: "task-queued", identity }, Date.now());
        if (queued.state !== state.workflowState) deps.persistWorkflowState(queued.state, ctx);
      }
      return true;
    } catch (error) {
      deps.setInternalContinuationPending(false);
      const latest = state.workflowState;
      const outcomeUnknown = firstDispatch && dispatchAttempted
        && latest?.handoff?.phase === "dispatching"
        && latest.handoff.handoffId === identity.handoffId;
      if (outcomeUnknown && latest) {
        const unknown = markWorkflowTaskOutcomeUnknown(latest, {
          taskId,
          reason: `派发任务消息后无法确认交接状态：${textOf(error)}`,
        });
        try {
          deps.persistWorkflowState(unknown, ctx);
        } catch (persistError) {
          ctx.ui.notify(`任务 ${taskId} 的执行结果未知，且无法持久化暂停状态：${textOf(persistError)}；不会自动重放`, "error");
        }
      }
      const failureMessage = outcomeUnknown
        ? `无法确认任务 ${taskId} 的交接结果；结果未知，不会自动重放。${textOf(error)}`
        : !dispatchAttempted
          ? `无法持久化任务 ${taskId} 的派发状态；任务消息尚未发送。${textOf(error)}`
          : `任务 ${taskId} 的状态已变化或提醒消息发送失败；未伪造完成或自动重放。${textOf(error)}`;
      ctx.ui.notify(failureMessage, "error");
      return false;
    } finally {
      state.workflowDispatchInFlight = false;
    }
  }

  function workflowReplanPrompt() {
    const workflow = state.workflowState;
    const request = workflow?.pendingRevision;
    if (!workflow || !request) throw new Error("当前没有待处理重规划");
    const dependencies = new Set(workflow.tasks.filter(task => task.status === "pending").flatMap(task => task.dependsOn));
    return [
      "[PI-INIT 工作流重规划]", ARCHITECT_RUNTIME_GUIDANCE,
      "本轮身份由运行时绑定，不将旧结果换成新身份。",
      "当前计划：" + JSON.stringify(workflow.plan),
      "待处理方向：" + request.direction,
      "已有任务与真实成果：" + JSON.stringify(workflow.tasks.filter(task => task.status !== "completed" && task.status !== "superseded" || dependencies.has(task.id)).map(task => ({ id: task.id, task: task.task, status: task.status, dependsOn: task.dependsOn, completionSummary: task.completionSummary, verification: task.verification, outcomeUnknown: task.outcomeUnknown, blockReason: task.blockReason }))),
      request.kind === "goal" ? "目标插入仍使用同一队列，显式retainTaskIds保留所有仍有效的pending任务；目标分组不是子工作流。" : "只修改未完成的后续计划；显式列出retainTaskIds，保留已完成成果。",
      '调用task_workflow(action="replan", summary=..., constraints=[...], tasks=[...], retainTaskIds=[...])；未知结果必须先核对副作用，由用户明确确认，不自动重试。',
    ].join("\n\n");
  }

  function sendWorkflowReplanMessage(ctx: ExtensionContext, expectedIdentity?: WorkflowReplanIdentity) {
    if (state.userStopRequested) return false;
    const current = state.workflowState;
    const continuation = current?.continuation;
    const revision = current?.pendingRevision;
    if (!current || current.status !== "replanning" || !revision || continuation?.kind !== "replan" || !continuation.handoffId) return false;
    const identity = workflowReplanIdentity(current);
    if (!identity) return false;
    if (expectedIdentity && !Object.keys(expectedIdentity).every((key) => identity[key as keyof WorkflowReplanIdentity] === expectedIdentity[key as keyof WorkflowReplanIdentity])) return false;
    const transition = transitionWorkflowDispatch(current, { type: "replan-dispatch-requested", identity }, Date.now());
    if (!transition.effects.length) return false;
    try {
      const content = [handoffSnapshotPrompt(state, "architect"), workflowReplanPrompt()].join("\n\n");
      deps.persistWorkflowState(transition.state, ctx);
      deps.setInternalContinuationPending(true);
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-replan",
          content,
          display: false,
          details: identity,
        },
        { triggerTurn: true },
      );
      const latest = state.workflowState;
      if (latest) {
        const queued = transitionWorkflowDispatch(latest, { type: "replan-queued", identity }, Date.now());
        if (queued.state !== latest) deps.persistWorkflowState(queued.state, ctx);
      }
      return true;
    } catch (error) {
      deps.setInternalContinuationPending(false);
      ctx.ui.notify(`无法确认架构重规划交接：${textOf(error)}；不会伪造派发成功`, "error");
      return false;
    } finally {
      state.workflowDispatchInFlight = false;
    }
  }

  return {
    lastContext: () => lastContext,
    workflowTaskPrompt,
    sendWorkflowTaskMessage,
    workflowReplanPrompt,
    sendWorkflowReplanMessage,
  };
}

export type WorkflowMessages = ReturnType<typeof createWorkflowMessages>;
