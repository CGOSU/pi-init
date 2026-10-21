import type { WorkflowState, WorkflowTask } from "./workflow-types.ts";

export type WorkflowProgressSuspicion = {
  kind: "repeated-revision" | "repeated-state" | "state-cycle";
  summary: string;
  evidence: string[];
};

export type WorkflowProgressObservation = {
  status: "observing" | "suspected-loop";
  summary: string;
  windowSize: number;
  historyLimit: number;
  noProgressActivity: { count: number; recent: string[] };
  lastVerifiedProgress?: { kind: "task-completion" | "plan-convergence"; taskId?: string; summary: string };
  suspicion?: WorkflowProgressSuspicion;
};

type SemanticClarification = Omit<NonNullable<WorkflowTask["clarification"]>, "handoff" | "createdAt">;
type SemanticTask = Omit<Pick<WorkflowTask,
  "id" | "task" | "role" | "files" | "acceptanceCriteria" | "dependsOn" | "goalId" | "priority" | "status"
  | "completionSummary" | "implementationRationale" | "verification" | "blockReason" | "outcomeUnknown"
  | "contract" | "clarification"
>, "clarification"> & { clarification?: SemanticClarification };
type SemanticGoal = { id: string; parentId: string; summary: string; constraints: string[] };

type SemanticState = {
  workflowId: string;
  status: WorkflowState["status"];
  pauseReason?: string;
  taskPauseReason?: string;
  plan: WorkflowState["plan"];
  tasks: SemanticTask[];
  goals?: SemanticGoal[];
  currentTaskId?: string;
};

type StateSnapshot = { key: string; label: string };
type RevisionObservation = { id: string; key: string; label: string };

const DEFAULT_HISTORY_LIMIT = 12;
const REPEATED_STATE_THRESHOLD = 3;

function semanticState(workflow: WorkflowState): SemanticState {
  return {
    workflowId: workflow.workflowId,
    status: workflow.status,
    ...(workflow.pauseReason ? { pauseReason: workflow.pauseReason } : {}),
    ...(workflow.taskPauseReason ? { taskPauseReason: workflow.taskPauseReason } : {}),
    plan: workflow.plan,
    tasks: workflow.tasks.map(task => ({
      id: task.id,
      task: task.task,
      role: task.role,
      files: task.files,
      acceptanceCriteria: task.acceptanceCriteria,
      dependsOn: task.dependsOn,
      ...(task.goalId ? { goalId: task.goalId } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      status: task.status,
      ...(task.completionSummary ? { completionSummary: task.completionSummary } : {}),
      ...(task.implementationRationale ? { implementationRationale: task.implementationRationale } : {}),
      ...(task.verification ? { verification: task.verification } : {}),
      ...(task.blockReason ? { blockReason: task.blockReason } : {}),
      ...(task.outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(task.contract ? { contract: task.contract } : {}),
      ...(task.clarification ? {
        clarification: {
          issueId: task.clarification.issueId,
          category: task.clarification.category,
          question: task.clarification.question,
          impact: task.clarification.impact,
          checkedFacts: task.clarification.checkedFacts,
          completedWork: task.clarification.completedWork,
          verification: task.clarification.verification,
          sideEffects: task.clarification.sideEffects,
        },
      } : {}),
    })),
    ...(workflow.goals ? {
      goals: workflow.goals.map(({ id, parentId, summary, constraints }) => ({ id, parentId, summary, constraints })),
    } : {}),
    ...(workflow.currentTaskId ? { currentTaskId: workflow.currentTaskId } : {}),
  };
}

function taskHasVerifiedCompletion(task: WorkflowTask | undefined): task is WorkflowTask {
  return Boolean(task && task.status === "completed" && !task.outcomeUnknown
    && task.completionSummary?.trim()
    && task.verification?.some(item => item.trim()));
}

function verifiedCompletion(previous: WorkflowState, next: WorkflowState) {
  const previousTasks = new Map(previous.tasks.map(task => [task.id, task]));
  return next.tasks.find(task => taskHasVerifiedCompletion(task) && !taskHasVerifiedCompletion(previousTasks.get(task.id)));
}

function taskPlanContent(task: WorkflowTask) {
  return {
    id: task.id,
    task: task.task,
    role: task.role,
    files: task.files,
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: task.dependsOn,
    ...(task.goalId ? { goalId: task.goalId } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.contract ? { contract: task.contract } : {}),
  };
}

function planContent(plan: WorkflowState["plan"], tasks: WorkflowTask[]) {
  return JSON.stringify({ plan: { summary: plan.summary, constraints: plan.constraints }, tasks: tasks.map(taskPlanContent) });
}

function verifiedPlanConvergence(previous: WorkflowState, next: WorkflowState) {
  const previouslyApplied = new Set(previous.revisions.filter(item => item.status === "applied").map(item => item.revisionId));
  const applied = next.revisions.find(item => item.status === "applied" && item.appliedAt !== undefined
    && item.newPlan && !previouslyApplied.has(item.revisionId));
  if (!applied?.newPlan) return undefined;

  const before = planContent(previous.plan, previous.tasks);
  const after = planContent(next.plan, next.tasks);
  const declared = planContent(applied.newPlan, applied.newPlan.tasks);
  if (before === after || after !== declared) return undefined;
  return { revisionId: applied.revisionId, summary: `已应用重规划 ${applied.revisionId}，计划与任务内容已实际改变。` };
}

function revisionObservation(workflow: WorkflowState): RevisionObservation | undefined {
  const revision = workflow.pendingRevision;
  if (!revision?.revisionId || !revision.direction.trim()) return undefined;
  const key = JSON.stringify([
    revision.kind ?? "replan",
    revision.direction.trim().replace(/\s+/g, " "),
    revision.goalParentId ?? "",
    revision.childGoal?.trim().replace(/\s+/g, " ") ?? "",
  ]);
  const label = revision.kind === "goal"
    ? `重复的新目标请求：${revision.childGoal?.trim() || revision.direction.trim()}`
    : `重复的重规划方向：${revision.direction.trim()}`;
  return { id: revision.revisionId, key, label };
}

export function createWorkflowProgressTracker(historyLimit = DEFAULT_HISTORY_LIMIT) {
  const limit = Number.isInteger(historyLimit) && historyLimit > 0 ? historyLimit : DEFAULT_HISTORY_LIMIT;
  let scope: string | undefined;
  let previousWorkflow: WorkflowState | undefined;
  let snapshots: StateSnapshot[] = [];
  let revisions: RevisionObservation[] = [];
  let seenRevisionIds: string[] = [];
  let suspicion: WorkflowProgressSuspicion | undefined;
  let lastVerifiedProgress: WorkflowProgressObservation["lastVerifiedProgress"];
  let repeatedStateKey: string | undefined;
  let repeatedStateCounts = { statusQuery: 0, automaticTurn: 0 };
  let noProgressActivity: string[] = [];

  function reset() {
    scope = undefined;
    previousWorkflow = undefined;
    snapshots = [];
    revisions = [];
    seenRevisionIds = [];
    suspicion = undefined;
    lastVerifiedProgress = undefined;
    repeatedStateKey = undefined;
    repeatedStateCounts = { statusQuery: 0, automaticTurn: 0 };
    noProgressActivity = [];
  }

  function observation(): WorkflowProgressObservation {
    if (suspicion) {
      return {
        status: "suspected-loop",
        summary: suspicion.summary,
        windowSize: snapshots.length,
        historyLimit: limit,
        noProgressActivity: { count: noProgressActivity.length, recent: [...noProgressActivity] },
        ...(lastVerifiedProgress ? { lastVerifiedProgress } : {}),
        suspicion,
      };
    }
    return {
      status: "observing",
      summary: lastVerifiedProgress
        ? `已核实${lastVerifiedProgress.kind === "task-completion" ? `任务进展：${lastVerifiedProgress.taskId}` : "计划收敛"}；之后的观察窗口尚未发现疑似循环。`
        : "尚无可核实的任务进展；当前观察不足以判定循环。",
      windowSize: snapshots.length,
      historyLimit: limit,
      noProgressActivity: { count: noProgressActivity.length, recent: [...noProgressActivity] },
      ...(lastVerifiedProgress ? { lastVerifiedProgress } : {}),
    };
  }

  function recordActivity(activity: string) {
    const label = activity.trim().slice(0, 120);
    if (!label) return;
    noProgressActivity.push(label);
    if (noProgressActivity.length > limit) noProgressActivity.shift();
  }

  function observe(workflow: WorkflowState, kind: "state" | "status-query" | "automatic-turn" = "state"): WorkflowProgressObservation {
    const currentScope = `${workflow.sessionId ?? ""}\u0000${workflow.workflowId}`;
    if (scope !== currentScope) {
      reset();
      scope = currentScope;
    }

    const completed = previousWorkflow ? verifiedCompletion(previousWorkflow, workflow) : undefined;
    const convergence = previousWorkflow && !completed ? verifiedPlanConvergence(previousWorkflow, workflow) : undefined;
    const progress = completed
      ? { kind: "task-completion" as const, taskId: completed.id, summary: completed.completionSummary!.trim() }
      : convergence
        ? { kind: "plan-convergence" as const, summary: convergence.summary }
        : undefined;
    if (progress) {
      lastVerifiedProgress = progress;
      snapshots = [];
      revisions = [];
      seenRevisionIds = [];
      suspicion = undefined;
      repeatedStateKey = undefined;
      repeatedStateCounts = { statusQuery: 0, automaticTurn: 0 };
      noProgressActivity = [];
    }

    const semantic = semanticState(workflow);
    const key = JSON.stringify(semantic);
    const activeTask = workflow.tasks.find(task => task.id === workflow.currentTaskId);
    const label = workflow.currentTaskId
      ? `${workflow.status} · ${workflow.currentTaskId} · ${activeTask?.status ?? "未知任务状态"}`
      : `${workflow.status} · ${workflow.plan.summary}`;

    if (key !== repeatedStateKey) {
      repeatedStateKey = key;
      repeatedStateCounts = { statusQuery: 0, automaticTurn: 0 };
    } else if ((kind === "status-query" || kind === "automatic-turn") && ["running", "replanning"].includes(workflow.status)) {
      const counter = kind === "status-query" ? "statusQuery" : "automaticTurn";
      repeatedStateCounts[counter]++;
      if (!suspicion && repeatedStateCounts[counter] >= REPEATED_STATE_THRESHOLD) {
        const observations = repeatedStateCounts[counter] + 1;
        suspicion = {
          kind: "repeated-state",
          summary: "同一工作流语义状态被多次重复观察；这是疑似无进展路径，不证明任务陷入死循环。",
          evidence: [
            `当前状态连续 ${observations} 次保持为 ${label}（含基线状态）。`,
            kind === "status-query"
              ? "计数来自显式状态查询；时间间隔、回合、角色和交接身份变化不构成进展或检测依据。"
              : "计数来自自动回合边界；普通工具活动、时间间隔、角色和交接身份变化不构成业务进展。",
          ],
        };
      }
    }

    if (!progress) {
      const revision = revisionObservation(workflow);
      if (revision && !seenRevisionIds.includes(revision.id)) {
        seenRevisionIds.push(revision.id);
        if (seenRevisionIds.length > limit) seenRevisionIds.shift();
        const priorSameAction = revisions.find(item => item.key === revision.key);
        revisions.push(revision);
        if (revisions.length > limit) revisions.shift();
        if (!suspicion && priorSameAction) {
          suspicion = {
            kind: "repeated-revision",
            summary: "检测到相同业务方向被多次独立请求；这是疑似重复路径，不证明工作流陷入死循环。",
            evidence: [
              priorSameAction.label,
              `两个不同 revision（${priorSameAction.id}、${revision.id}）表达相同方向，身份/时间变化不作为进展。`,
            ],
          };
        }
      }

      const previousSnapshot = snapshots.at(-1);
      if (!previousSnapshot || previousSnapshot.key !== key) {
        if (!suspicion && snapshots.length >= 2 && snapshots.at(-2)?.key === key) {
          const cycle = [snapshots.at(-2)!.label, previousSnapshot!.label, label];
          suspicion = {
            kind: "state-cycle",
            summary: "检测到工作流语义状态 A→B→A 往返；这是疑似循环，不证明任务无法收敛。",
            evidence: [`重复路径：${cycle.join(" → ")}`, "比较的是任务/计划业务状态，已排除时间戳、回合、角色和交接身份。"],
          };
        }
        snapshots.push({ key, label });
        if (snapshots.length > limit) snapshots.shift();
      }
    } else {
      const snapshot = { key, label };
      snapshots = [snapshot];
    }

    previousWorkflow = structuredClone(workflow);
    return observation();
  }

  function observeActivity(workflow: WorkflowState | undefined, activity: string) {
    if (!workflow) return undefined;
    recordActivity(activity);
    return observe(workflow, "state");
  }

  return { observe, observeActivity, reset };
}
