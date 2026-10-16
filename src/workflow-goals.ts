import { randomUUID } from "node:crypto";
import { assertAcyclic, cloneState, cloneTask, normalizeIdentityToken, normalizeTask, normalizeTaskIds, normalizeTextList, requireText, requireTimestamp } from "./workflow-model.ts";
import { requestWorkflowReplan } from "./workflow-replan.ts";
import type { WorkflowGoal, WorkflowPlan, WorkflowState, WorkflowTask } from "./workflow-types.ts";

export function normalizeWorkflowGoals(value: unknown, rootId: string, tasks: WorkflowTask[]): WorkflowGoal[] {
  if (value === undefined) value = [];
  if (!Array.isArray(value)) throw new Error("goals 必须是目标归属数组");
  const goals: WorkflowGoal[] = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("目标归属格式无效");
    const goal = item as Record<string, unknown>;
    return { id: normalizeIdentityToken(goal.id, "目标 id"), parentId: normalizeIdentityToken(goal.parentId, "父目标 id"), summary: requireText(goal.summary, "目标说明"), constraints: normalizeTextList(goal.constraints, "目标约束"), createdAt: requireTimestamp(goal.createdAt, "目标创建时间") };
  });
  const byId = new Map(goals.map(goal => [goal.id, goal]));
  if (byId.size !== goals.length || byId.has(rootId)) throw new Error("目标 id 重复或与根目标冲突");
  for (const goal of goals) {
    const seen = new Set([goal.id]);
    let parent = goal.parentId;
    while (parent !== rootId) {
      if (seen.has(parent)) throw new Error("目标归属存在循环");
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) throw new Error("目标归属引用不存在的父目标");
      parent = ancestor.parentId;
    }
  }
  for (const task of tasks) if (task.goalId && task.goalId !== rootId && !byId.has(task.goalId)) throw new Error("任务引用不存在的目标归属：" + task.goalId);
  return goals;
}

export function requestWorkflowGoal(state: WorkflowState, input: { direction?: unknown; parentGoalId?: unknown }, now = Date.now()): WorkflowState {
  const current = state.tasks.find(task => task.id === state.currentTaskId);
  const parentId = normalizeIdentityToken(input.parentGoalId ?? current?.goalId ?? state.workflowId, "父目标 id");
  if (parentId !== state.workflowId && !state.goals?.some(goal => goal.id === parentId)) throw new Error("父目标不存在");
  return requestWorkflowReplan(state, { direction: input.direction, childGoal: input.direction, kind: "goal", goalParentId: parentId }, now);
}

export function validateWorkflowGoalPlan(state: WorkflowState, input: unknown): WorkflowPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("目标计划格式无效");
  const plan = input as Record<string, unknown>;
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw new Error("新目标至少需要一个任务");
  const tasks = plan.tasks.map((task, index) => normalizeTask(task, index));
  if (tasks.some(task => task.goalId !== undefined)) throw new Error("插入目标的任务归属由运行时分配，请勿指定 goalId");
  const known = new Set(state.tasks.map(task => task.id));
  for (const revision of state.revisions) for (const task of [...(revision.previousTasks ?? []), ...(revision.replacedTasks ?? []), ...(revision.newPlan?.tasks ?? [])]) known.add(task.id);
  for (const task of tasks) { if (known.has(task.id)) throw new Error("新目标不能复用已有或历史任务 id：" + task.id); known.add(task.id); }
  assertAcyclic([...state.tasks, ...tasks]);
  return { summary: requireText(plan.summary, "新目标说明"), constraints: normalizeTextList(plan.constraints, "新目标约束"), tasks, reviewRequired: false };
}

export function createWorkflowGoalState(state: WorkflowState, input: unknown, now = Date.now()): WorkflowState {
  if (state.status !== "replanning" || state.pendingRevision?.kind !== "goal" || state.currentTaskId || state.handoff) throw new Error("只允许在安全规划边界向队列插入目标");
  const plan = validateWorkflowGoalPlan(state, input);
  const retained = normalizeTaskIds((input as Record<string, unknown>).retainTaskIds, "目标插入 retainTaskIds");
  const pending = state.tasks.filter(task => task.status === "pending").map(task => task.id);
  if (retained.length !== pending.length || retained.some(id => !pending.includes(id))) throw new Error("插入目标必须通过 retainTaskIds 明确确认保留全部原有待执行任务；替换任务请使用普通重规划");
  const next = cloneState(state, now);
  const id = "goal-" + randomUUID();
  const added = plan.tasks.map(task => ({ ...cloneTask(task), goalId: id, priority: task.priority ?? 0 }));
  const revision = next.revisions.find(revision => revision.revisionId === state.pendingRevision!.revisionId);
  if (!revision || revision.status !== "requested") throw new Error("目标插入缺少有效 revision");
  revision.status = "applied"; revision.appliedAt = now;
  revision.previousPlan = { ...state.plan, constraints: [...state.plan.constraints] };
  revision.previousTasks = state.tasks.map(cloneTask);
  revision.retainedTaskIds = retained;
  revision.addedTaskIds = added.map(task => task.id);
  revision.newPlan = { summary: plan.summary, constraints: plan.constraints, tasks: added.map(cloneTask) };
  next.goals = [...(next.goals ?? []), { id, parentId: state.pendingRevision.goalParentId ?? state.workflowId, summary: plan.summary, constraints: plan.constraints, createdAt: now }];
  next.tasks.push(...added);
  normalizeWorkflowGoals(next.goals, next.workflowId, next.tasks);
  next.planVersion += 1; next.recoveryGeneration += 1;
  next.status = "running";
  delete next.pendingRevision; delete next.pauseReason; delete next.taskPauseReason; delete next.completedAt;
  next.continuation = { kind: "schedule", phase: "pending", reason: "replan-applied" };
  next.nudgeCount = 0;
  return next;
}

export function workflowGoalProgress(state: WorkflowState) {
  return (state.goals ?? []).map(goal => {
    const ids = new Set([goal.id]);
    let size = 0;
    while (size !== ids.size) { size = ids.size; for (const child of state.goals ?? []) if (ids.has(child.parentId)) ids.add(child.id); }
    const tasks = state.tasks.filter(task => task.goalId && ids.has(task.goalId) && task.status !== "superseded");
    const completed = tasks.filter(task => task.status === "completed").length;
    const status = !tasks.length ? "inactive" : completed === tasks.length ? (tasks.every(task => task.verification?.length) ? "completed" : "review-required") : tasks.some(task => task.status === "blocked") ? "blocked" : tasks.some(task => task.status === "in_progress") ? "in_progress" : "pending";
    return { ...goal, completed, total: tasks.length, status };
  });
}
