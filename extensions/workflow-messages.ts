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
import { getAcceptedEvidence } from "../src/coordination.ts";
import { textOf } from "./runtime-state.ts";
import { transitionWorkflowDispatch } from "../src/workflow-orchestrator.ts";

const GENERIC_TASK_TOOL_GUIDANCE = "遵循公共 pi-init-role-routing Skill 的读写与安全边界；只修改当前任务允许范围。关键事实、业务契约或业务决策缺失时，developer-test 必须调用 task_workflow(action=\"clarify\") 并停止，不得猜测；普通可逆工程细节按工程自由度自主决定，实际验证并报告真实结果。";
const ARCHITECT_RUNTIME_GUIDANCE =
  `架构师不取证、不执行、不连接 MCP，只负责思考、决策、规划和安排；运行时仅可调用 switch_role，以及 task_workflow 的 ${ARCHITECT_ALLOWED_ACTIONS_TEXT}（后两者是纯协议规划/审阅动作）。需要最新事实时，先通过 request-evidence 交由 docs-commit 查证；architect 不得调用 clarify、complete、block、resume、retry 或 cancel。`;

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
    ? "用户在工作流期间提出新目标时，必须将其规划为嵌套子工作流，保留父工作流和已完成成果；只有用户明确要求修改现有计划时才重规划父层。不得派发旧计划的下一任务；使用 task_workflow(action=\"replan\") 处理当前带身份的请求。"
    : "用户在工作流期间提出新目标时，扩展会将其记录为嵌套子工作流，父工作流进度保留并在安全任务边界交给架构师规划。明确要求修改现有计划时才进入父层重规划。不要自行派发旧计划下一任务；若必须立即停止当前任务，使用现有 cancel 流程。";
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
      workflowState.subworkflowContract ? `子流程契约：${JSON.stringify(workflowState.subworkflowContract)}\n返回父流程：${workflowState.parentStack?.at(-1)?.state.workflowId}。只交付契约要求的结果与实际验证；不得再创建子流程。allowedFiles 是声明的修改范围，不是工具沙箱。` : "",
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
    const type = current.handoff?.phase === "executing" ? "task-reminder-requested" : "task-dispatch-requested";
    const transition = transitionWorkflowDispatch(current, { type, identity }, Date.now());
    if (!transition.effects.length) return false;
    const firstDispatch = transition.state !== current;
    let dispatchAttempted = false;
    try {
      const content = workflowTaskPrompt(taskId, note);
      if (firstDispatch) {
        deps.persistWorkflowState(transition.state, ctx);
      }
      deps.setInternalContinuationPending(true);
      dispatchAttempted = true;
      deps.pi.sendMessage(
        {
          customType: "pi-init-workflow-task",
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

  function workflowReplanPrompt(identity: WorkflowReplanIdentity) {
    const workflowState = state.workflowState;
    const request = workflowState?.pendingRevision;
    if (!workflowState || !request) throw new Error("工作流缺少待处理的重规划请求");
    if (workflowState.pauseReason === "child-result-review") {
      const child = workflowState.subworkflowHistory?.findLast((entry) => entry.parentWorkflowId === workflowState.workflowId);
      const remaining = workflowState.tasks.filter((task) => task.status !== "completed" && task.status !== "superseded");
      const dependencies = new Set(remaining.flatMap((task) => task.dependsOn));
      const parentTasks = [...remaining, ...workflowState.tasks.filter((task) => task.status === "completed" && dependencies.has(task.id))];
      return [
        "[PI-INIT 子流程结果与父计划审阅]",
        `当前审阅/重规划身份 JSON：${JSON.stringify(identity)}`,
        `父计划：${JSON.stringify({ ...workflowState.plan, tasks: parentTasks })}`,
        `子流程结果包（状态、输出、验证、副作用未知标记、契约和审阅记录）：${JSON.stringify(child)}`,
        `待处理指令：${request.direction}`,
        "architect 只审阅与决策；缺少实际核查依据时用 request-evidence/review-evidence，不得自行取证。调用 task_workflow(action=review-child, 上述全部身份, childReview={childWorkflowId,decision:continue|replan|block,reason,parentPlanValid,acceptedOutputs:[按原文列出已满足的 expectedOutputs],verification:[实际验证依据]})。",
        "仅在子流程成功、全部输出满足、验证完整且父计划仍有效时 continue。取消、结果未知或契约缺失不得 continue；发现影响则 replan，不能确认则 block。replan 决定后以同一身份调用 replan 修改父计划并保留有效任务，不重放副作用。子流程结束本身不解除父任务等待条件。",
      ].join("\n\n");
    }
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
      request.kind === "nested" ? "[PI-INIT 嵌套子工作流规划]" : "[PI-INIT 工作流重规划]",
      request.kind === "nested"
        ? `当前子工作流规划身份 JSON（replan 时按原样传回）：${JSON.stringify(identity)}`
        : `当前重规划身份 JSON（replan 时按原样传回）：${JSON.stringify(identity)}`,
      `工作流当前 revisionId：${request.revisionId}`,
      request.kind === "nested"
        ? `新子工作流目标（不得覆盖或重置父工作流）：\n${request.childGoal ?? request.direction}`
        : `用户新增方向或需求（按提交顺序合并的全部指令）：\n${request.direction.split("\n").map((item) => `- ${item}`).join("\n")}`,
      `当前工作流目标：${workflowState.plan.summary}`,
      workflowState.plan.constraints.length > 0 ? `原架构约束：\n${workflowState.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
      completed.length > 0 ? `未完成任务直接依赖的已完成成果：\n${completed.join("\n")}` : "",
      pending.length > 0 ? `旧计划中尚未开始的任务：\n${pending.join("\n")}` : "无旧的未开始任务",
      relevantEvidence.length > 0 ? `未完成任务相关的已接受证据：\n${relevantEvidence.join("\n")}` : "",
      clarifications.length > 0
        ? request.kind === "nested"
          ? `父工作流仍保留的澄清与副作用记录（属于父层，不要求子计划代替解决）：\n${clarifications.join("\n")}`
          : `开发者正式退回的澄清（必须逐项处置）：\n${clarifications.join("\n")}`
        : "",
      "规划边界：architect 不直接取证、不执行代码、不连接 MCP；允许通过 request-evidence 安排 docs-commit 查证，并通过 review-evidence 接受、补查或阻塞。缺关键事实时先取证；契约冲突应依据已接受证据/明确需求解决；业务决策缺失必须向用户确认，不能猜测或应用含 blockingQuestions 的计划。",
      request.kind === "nested"
        ? "只规划 childGoal 对应的独立子工作流；不要覆盖父层计划或把父层未完成任务搬入子层。父层任务、澄清、身份与已完成成果会被原样挂起，子层完成后返回父层审阅结果与计划有效性，不直接恢复执行。提交 replan 必须提供独立 subworkflowContract={inputs:[...],expectedOutputs:[...],acceptanceCriteria:[...],allowedFiles:[...]}；返回位置由运行时父层身份绑定，仅允许一层活动子流程。不得重放父层副作用为 occurred/unknown 的任务。"
        : "请只规划未完成的后续工作；不要修改已完成任务的摘要或验证记录。旧任务的 completedWork 与验证已持久化在澄清报告中，不得将被澄清任务伪报完成。副作用为 occurred/unknown 时不得自动重放；新任务契约必须通过 clarificationResolutions 明确说明处理方式，未核实则不得派发。",
      request.kind === "nested"
        ? "子层 task ID 只须在新子工作流内唯一；不要继承、替换或重写父层任务 ID。"
        : "若只是新增后续工作，把仍有效的旧任务 ID 放入 retainTaskIds；新增 tasks 必须使用从未出现过的新 ID。若替换旧任务，不要把被替换任务 ID 放进新 tasks，也不要让新任务依赖被替换任务。",
      request.kind === "nested"
        ? `子工作流契约仍须逐任务完整列出 requirementSources、expectedBehavior、evidence、fixedDecisions、invariants、nonGoals、blockingQuestions、engineeringDiscretion、verification 和 clarificationResolutions；任何关键未决问题都必须留在 blockingQuestions 并阻止提交。规划完成后调用 task_workflow(action="replan", workflowId="${identity.workflowId}", planVersion=${identity.planVersion}, sessionId="${identity.sessionId}", recoveryGeneration=${identity.recoveryGeneration}, revisionId="${request.revisionId}", handoffId="${identity.handoffId}", summary=..., constraints=[...], tasks=[...])。运行时会将该计划创建为独立子工作流，父计划、任务和身份不变；不要传 retainTaskIds。只有架构角色可以提交该动作。`
        : `开发契约必须逐任务列出 requirementSources、expectedBehavior、evidence、fixedDecisions、invariants、nonGoals、blockingQuestions、engineeringDiscretion、verification 和 clarificationResolutions；任何关键未决问题都必须留在 blockingQuestions 并阻止 replan。规划完成后，必须调用 task_workflow(action="replan", workflowId="${identity.workflowId}", planVersion=${identity.planVersion}, sessionId="${identity.sessionId}", recoveryGeneration=${identity.recoveryGeneration}, revisionId="${request.revisionId}", handoffId="${identity.handoffId}", summary=..., constraints=[...], tasks=[...], retainTaskIds=[...])。只有架构角色可以提交该动作。`,
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
    const transition = transitionWorkflowDispatch(current, { type: "replan-dispatch-requested", identity }, Date.now());
    if (!transition.effects.length) return false;
    try {
      const content = workflowReplanPrompt(identity);
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
    workflowTaskPrompt,
    sendWorkflowTaskMessage,
    workflowReplanPrompt,
    sendWorkflowReplanMessage,
  };
}

export type WorkflowMessages = ReturnType<typeof createWorkflowMessages>;
