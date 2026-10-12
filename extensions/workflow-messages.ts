import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  cloneState,
  getWorkflowTask,
  markWorkflowTaskOutcomeUnknown,
  setWorkflowHandoffPhase,
  workflowHandoffIdentity,
  workflowReplanIdentity,
} from "../src/workflow.ts";
import type {
  ExtensionRuntimeState,
  WorkflowHandoffIdentity,
  WorkflowReplanIdentity,
  WorkflowState,
} from "./runtime-state.ts";
import { getAcceptedEvidence } from "../src/coordination.ts";
import { textOf } from "./runtime-state.ts";

const GENERIC_TASK_TOOL_GUIDANCE = "遵循公共 pi-init-role-routing Skill 的读写与安全边界；只修改当前任务允许范围。关键事实、业务契约或业务决策缺失时，developer-test 必须调用 task_workflow(action=\"clarify\") 并停止，不得猜测；普通可逆工程细节按工程自由度自主决定，实际验证并报告真实结果。";
const ARCHITECT_RUNTIME_GUIDANCE =
  "架构师不取证、不执行、不连接 MCP，只负责思考、决策、规划和安排；运行时仅可调用 switch_role，以及 task_workflow 的 plan、replan、status、request-evidence、review-evidence。需要最新事实时，先通过 request-evidence 交由 docs-commit 查证；architect 不得调用 clarify、complete、block、resume、retry 或 cancel。";

function taskRoleGuidance(role: string) {
  if (role === "architect") return ARCHITECT_RUNTIME_GUIDANCE;
  if (role === "docs-commit") {
    return "docs-commit 负责取证和文档/Git 收尾；交接事实与风险，不替 architect 做关键决策，也不修改代码。";
  }
  return "";
}

function evidenceSummary(state: ExtensionRuntimeState, reference: { findingId: string; sourceId: string; sourceVersion: string }) {
  const coordination = state.coordinationRuntimeState?.coordination;
  const acceptedResult = coordination ? getAcceptedEvidence(coordination) : undefined;
  const accepted = acceptedResult?.ok && acceptedResult.value.some((item) => item.findingId === reference.findingId
    && item.sourceId === reference.sourceId
    && item.sourceVersion === reference.sourceVersion);
  const finding = coordination?.reports.flatMap((report) => report.findings).find((item) =>
    item.findingId === reference.findingId
    && item.sources.some((source) => source.id === reference.sourceId && source.version === reference.sourceVersion));
  const referenceText = `${reference.findingId} · ${reference.sourceId}@${reference.sourceVersion}`;
  if (!accepted || !finding) return `${referenceText}（当前账本无法核对已接受事实，不得据此推断）`;
  return `${referenceText}：${finding.statement}`;
}

function contractPrompt(
  contract: NonNullable<WorkflowState["tasks"][number]["contract"]>,
  state: ExtensionRuntimeState,
) {
  const lines = (label: string, values: readonly string[]) =>
    `${label}：\n${values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- 无"}`;
  return [
    "开发任务契约（不得改写固定决策；未决关键问题非空时不得开始）：",
    `预期结果：${contract.outcome}`,
    lines("需求来源", contract.requirementSources),
    lines("预期行为", contract.expectedBehavior),
    lines("已接受证据（保持来源版本）", contract.evidence.map((item) => evidenceSummary(state, item))),
    lines("固定决策", contract.fixedDecisions),
    lines("不变量", contract.invariants),
    lines("非目标", contract.nonGoals),
    lines("关键未决问题", contract.blockingQuestions),
    lines("工程自由度（普通、可逆细节由开发者自主决定）", contract.engineeringDiscretion),
    lines("验证要求", contract.verification),
    lines("澄清处置", (contract.clarificationResolutions ?? []).map((item) => `${item.issueId}: ${item.resolution}（side effects: ${item.sideEffectDisposition}）`)),
  ].join("\n");
}

function taskToolGuidance(role: string) {
  return role === "architect"
    ? `${ARCHITECT_RUNTIME_GUIDANCE} 不得调用 read、grep、find、ls、ffgrep、fffind、browser、shell、edit、write、init_project、subtask、agent_message、MCP/mcpScript 或任何未知工具。`
    : GENERIC_TASK_TOOL_GUIDANCE;
}

function taskDirectionGuidance(role: string) {
  return role === "architect"
    ? "如果用户在本工作流期间提出会改变后续方向或新增后续工作，架构师不得派发旧计划的下一任务；只能通过 task_workflow(action=\"replan\") 重新规划，或调用 switch_role 将执行交给对应角色。"
    : "如果用户在本工作流期间提出会改变后续方向或新增后续工作的普通描述，不要自行派发旧计划的下一任务；扩展会先记录重规划请求，当前任务完成后交给架构师重规划。若必须立即停止当前任务，使用现有 cancel 流程。";
}

function taskCompletionGuidance(role: string, identity: WorkflowHandoffIdentity, hasContract: boolean) {
  if (role === "architect") {
    return "架构师不直接执行或验证任务，不得调用 task_workflow 的 clarify、complete、block、resume、retry、cancel；仅可规划、重规划、查询状态或安排取证/审阅。";
  }
  const clarify = role === "developer-test" && hasContract
    ? `若发现影响业务结果的关键事实、契约冲突或业务决策缺失，立即调用 task_workflow(action="clarify", workflowId="${identity.workflowId}", planVersion=${identity.planVersion}, sessionId="${identity.sessionId}", recoveryGeneration=${identity.recoveryGeneration}, taskId="${identity.taskId}", attemptId="${identity.attemptId}", handoffId="${identity.handoffId}", clarification={category:"missing-fact|contract-conflict|business-decision", question:..., impact:..., checkedFacts:[...], completedWork:[...], verification:[实际命令及结果], sideEffects:{status:"none|occurred|unknown", details:[...]}})，随后停止实现。checkedFacts 是提交给 architect 审阅的观察，不会自动成为已接受证据。明确报告未知/已发生的副作用；不得自动重放。普通可逆 helper、命名和局部组织等工程选择应在 engineeringDiscretion 范围内自主处理，不要无意义澄清。`
    : "";
  return `${clarify}${clarify ? "\n\n" : ""}完成并实际验证后，必须调用 task_workflow(action="complete", workflowId="${identity.workflowId}", planVersion=${identity.planVersion}, sessionId="${identity.sessionId}", recoveryGeneration=${identity.recoveryGeneration}, taskId="${identity.taskId}", attemptId="${identity.attemptId}", handoffId="${identity.handoffId}", completionSummary=..., implementationRationale=..., verification=[...])。implementationRationale 说明为什么采用该实现及关键取舍，不要重复 completionSummary；verification 只能填写实际执行过的命令和结果。若属于普通实现失败而非契约澄清，调用 task_workflow(action="block", 并原样提供上述全部身份字段, reason=...)，不要伪造完成。`;
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
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}${item.implementationRationale ? `；取舍：${item.implementationRationale}` : ""}${(item.verification ?? []).length ? `；验证：${(item.verification ?? []).join("；")}` : ""}`);

    return [
      "[PI-INIT 自动任务工作流]",
      `工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `当前任务直接依赖成果：\n${completed.join("\n")}` : "",
      `当前任务（${task.id}，角色 ${task.role}）：${task.task}`,
      `当前任务结果身份 JSON（${task.contract && task.role === "developer-test" ? "clarify/" : ""}complete/block 时按原样传回）：${JSON.stringify(identity)}`,
      `允许涉及的文件或目录：${task.files.join(", ")}`,
      `验收标准：\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      task.contract ? contractPrompt(task.contract, state) : "",
      taskRoleGuidance(task.role),
      note ? `调度提示：${note}` : "",
      taskToolGuidance(task.role),

      taskDirectionGuidance(task.role),
      "除非遇到真正阻塞的需求、权限、凭据、破坏性操作或必须由用户决定的产品取舍，不要询问用户；做合理假设并记录。",
      taskCompletionGuidance(task.role, identity, Boolean(task.contract)),
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowTaskMessage(
    ctx: ExtensionContext,
    taskId: string,
    note?: string,
    expectedIdentity?: WorkflowHandoffIdentity,
  ) {
    const current = state.workflowState;
    const identity = current ? workflowHandoffIdentity(current) : undefined;
    if (!current || current.currentTaskId !== taskId || !identity
      || (expectedIdentity && !Object.keys(expectedIdentity).every((key) => identity[key as keyof WorkflowHandoffIdentity] === expectedIdentity[key as keyof WorkflowHandoffIdentity]))) {
      return false;
    }
    const firstDispatch = ["prepared", "waiting-role", "compacting"].includes(current.handoff?.phase ?? "");
    if (!firstDispatch && !["executing"].includes(current.handoff?.phase ?? "")) return false;
    let dispatchAttempted = false;
    try {
      if (firstDispatch) {
        deps.persistWorkflowState(setWorkflowHandoffPhase(current, "dispatching"), ctx);
      }
      deps.setInternalContinuationPending(true);
      dispatchAttempted = true;
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-task",
          content: workflowTaskPrompt(taskId, note),
          display: false,
          details: identity,
        },
        { triggerTurn: true },
      );
      if (firstDispatch
        && state.workflowState?.handoff?.handoffId === identity.handoffId
        && state.workflowState.handoff.phase === "dispatching") {
        deps.persistWorkflowState(setWorkflowHandoffPhase(state.workflowState, "queued"), ctx);
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

  function workflowReplanPrompt(identity: WorkflowReplanIdentity) {
    const workflowState = state.workflowState;
    const request = workflowState?.pendingRevision;
    if (!workflowState || !request) throw new Error("工作流缺少待处理的重规划请求");
    const pending = workflowState.tasks
      .filter((item) => item.status === "pending")
      .map((item) => `- ${item.id}: ${item.task}；依赖：${item.dependsOn.join(", ") || "无"}`);
    const dependencyIds = new Set(workflowState.tasks
      .filter((item) => item.status === "pending")
      .flatMap((item) => item.dependsOn));
    const completed = workflowState.tasks
      .filter((item) => item.status === "completed" && dependencyIds.has(item.id))
      .map((item) => `- ${item.id}: ${item.completionSummary ?? "已完成"}${item.implementationRationale ? `；取舍：${item.implementationRationale}` : ""}${(item.verification ?? []).length ? `；验证：${(item.verification ?? []).join("；")}` : ""}`);
    const evidenceReferences = new Map<string, { findingId: string; sourceId: string; sourceVersion: string }>();
    for (const task of workflowState.tasks) {
      if (task.status === "completed" || task.status === "superseded") continue;
      for (const reference of task.contract?.evidence ?? []) {
        evidenceReferences.set(JSON.stringify([reference.findingId, reference.sourceId, reference.sourceVersion]), reference);
      }
    }
    const relevantEvidence = [...evidenceReferences.values()].map((reference) => `- ${evidenceSummary(state, reference)}`);
    const clarifications = workflowState.tasks
      .filter((item) => item.clarification)
      .map((item) => {
        const report = item.clarification!;
        return [
          `- ${report.issueId}（任务 ${item.id}；${report.category}）：${report.question}`,
          `  影响：${report.impact}`,
          `  开发者已核查观察（尚非 architect 接受证据）：${report.checkedFacts.join("；") || "无"}`,
          `  已完成工作：${report.completedWork.join("；") || "无"}`,
          `  实际验证：${report.verification.join("；") || "未运行"}`,
          `  副作用 ${report.sideEffects.status}：${report.sideEffects.details.join("；") || "无"}`,
          `  原 handoff：${JSON.stringify(report.handoff)}`,
        ].join("\n");
      });

    return [
      "[PI-INIT 工作流重规划]",
      `当前重规划身份 JSON（replan 时按原样传回）：${JSON.stringify(identity)}`,
      `工作流当前 revisionId：${request.revisionId}`,
      `用户新增方向或需求（按提交顺序合并的全部指令）：\n${request.direction.split("\n").map((item) => `- ${item}`).join("\n")}`,
      `当前工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `原架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `未完成任务直接依赖的已完成成果：\n${completed.join("\n")}` : "",
      pending.length > 0 ? `旧计划中尚未开始的任务：\n${pending.join("\n")}` : "无旧的未开始任务",
      relevantEvidence.length > 0 ? `未完成任务相关的已接受证据：\n${relevantEvidence.join("\n")}` : "",
      clarifications.length > 0 ? `开发者正式退回的澄清（必须逐项处置）：\n${clarifications.join("\n")}` : "",
      "规划边界：architect 不直接取证、不执行代码、不连接 MCP；允许通过 request-evidence 安排 docs-commit 查证，并通过 review-evidence 接受、补查或阻塞。缺关键事实时先取证；契约冲突应依据已接受证据/明确需求解决；业务决策缺失必须向用户确认，不能猜测或应用含 blockingQuestions 的计划。",
      "请只规划未完成的后续工作；不要修改已完成任务的摘要或验证记录。旧任务的 completedWork 与验证已持久化在澄清报告中，不得将被澄清任务伪报完成。副作用为 occurred/unknown 时不得自动重放；新任务契约必须通过 clarificationResolutions 明确说明处理方式，未核实则不得派发。",
      "若只是新增后续工作，把仍有效的旧任务 ID 放入 retainTaskIds；新增 tasks 必须使用从未出现过的新 ID。若替换旧任务，不要把被替换任务 ID 放进新 tasks，也不要让新任务依赖被替换任务。",
      `开发契约必须逐任务列出 requirementSources、expectedBehavior、evidence、fixedDecisions、invariants、nonGoals、blockingQuestions、engineeringDiscretion、verification 和 clarificationResolutions；任何关键未决问题都必须留在 blockingQuestions 并阻止 replan。规划完成后，必须调用 task_workflow(action="replan", workflowId="${identity.workflowId}", planVersion=${identity.planVersion}, sessionId="${identity.sessionId}", recoveryGeneration=${identity.recoveryGeneration}, revisionId="${request.revisionId}", handoffId="${identity.handoffId}", summary=..., constraints=[...], tasks=[...], retainTaskIds=[...])。只有架构角色可以提交该动作。`,
      "不要调用 complete、block 或 cancel 来代替 replan；如果无法形成可靠的新计划，说明真正阻塞原因并保持当前重规划状态。",
    ].filter(Boolean).join("\n\n");
  }

  function sendWorkflowReplanMessage(ctx: ExtensionContext, expectedIdentity?: WorkflowReplanIdentity) {
    const current = state.workflowState;
    const continuation = current?.continuation;
    const revision = current?.pendingRevision;
    if (!current || current.status !== "replanning" || !revision || continuation?.kind !== "replan" || !continuation.handoffId) return false;
    const identity = workflowReplanIdentity(current);
    if (!identity) return false;
    if (expectedIdentity && !Object.keys(expectedIdentity).every((key) => identity[key as keyof WorkflowReplanIdentity] === expectedIdentity[key as keyof WorkflowReplanIdentity])) return false;
    try {
      if (continuation.phase !== "dispatching" && continuation.phase !== "queued") {
        const dispatching = cloneState(current);
        dispatching.continuation = { ...continuation, phase: "dispatching" };
        deps.persistWorkflowState(dispatching, ctx);
      }
      deps.setInternalContinuationPending(true);
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-replan",
          content: workflowReplanPrompt(identity),
          display: false,
          details: identity,
        },
        { triggerTurn: true },
      );
      const latest = state.workflowState;
      if (latest?.continuation?.kind === "replan" && latest.continuation.handoffId === identity.handoffId) {
        const queued = cloneState(latest);
        queued.continuation = { ...latest.continuation, phase: "queued" };
        deps.persistWorkflowState(queued, ctx);
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
    workflowTaskPrompt,
    sendWorkflowTaskMessage,
    workflowReplanPrompt,
    sendWorkflowReplanMessage,
  };
}

export type WorkflowMessages = ReturnType<typeof createWorkflowMessages>;
