import { StringEnum } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROLE_ID_PATTERN, THINKING_LEVELS, WORKFLOW_MODES } from "../src/roles.ts";
import type { ResolvedRoleConfig, RoleModelConfig } from "../src/role-types.ts";
export type { ResolvedRoleConfig, RoleModelConfig } from "../src/role-types.ts";
import { WORKFLOW_RECOMMENDED_TASKS } from "../src/workflow.ts";

export type RunTimingEntryData = {
  source?: unknown;
  inputAt?: unknown;
  beforeAgentStartAt?: unknown;
  startedAt?: unknown;
  agentStartCount?: unknown;
  beforeProviderRequestAt?: unknown;
  lastProviderRequestAt?: unknown;
  providerRequestCount?: unknown;
  providerRequestDurations?: unknown;
  firstMessageUpdateAt?: unknown;
  assistantMessageEndAt?: unknown;
  assistantMessageEndCount?: unknown;
  agentEndAt?: unknown;
  agentEndCount?: unknown;
  toolExecutionStartAt?: unknown;
  toolExecutionEndAt?: unknown;
  toolExecutionDurationMs?: unknown;
  toolExecutionCount?: unknown;
  toolNames?: unknown;
  toolDurations?: unknown;
  completedAt?: unknown;
  settledAt?: unknown;
};

export type ReportTheme = Pick<Theme, "fg" | "bold">;

export type MenuItem = {
  value: string;
  label: string;
  description?: string;
};

export type MenuSaveResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type MenuSaveHandler = (selection?: string | RoleModelConfig) => Promise<MenuSaveResult | void> | MenuSaveResult | void;

export type MenuOptions = {
  summary?: string[];
  maxVisible?: number;
  selectedValue?: string;
  onSave?: MenuSaveHandler;
};

export const roleModelSchema = Type.Object({
  provider: Type.String({ description: "模型提供商 ID" }),
  model: Type.String({ description: "模型 ID" }),
  thinkingLevel: StringEnum(THINKING_LEVELS, {
    description: "Pi 推理强度",
  }),
});

export const roleModelsMapSchema = Type.Record(
  Type.String({
    pattern: ROLE_ID_PATTERN.source,
    description: "角色 ID：小写字母、数字和单连字符",
  }),
  roleModelSchema,
  { description: "项目启用的角色及其模型映射" },
);

export const roleModelsSchema = Type.Object({
  schemaVersion: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 2,
    description: "角色模型配置版本；当前保存版本为 2",
  })),
  workflowMode: Type.Optional(StringEnum(WORKFLOW_MODES, {
    description: "任务工作流策略：off、on 或 auto（auto 在不超过 2 个任务时跳过编排）",
  })),
  workflowEnabled: Type.Optional(Type.Boolean({
    description: "兼容旧配置；未设置 workflowMode 时 true 映射 on、false 映射 off",
  })),
  roleModels: Type.Optional(roleModelsMapSchema),
}, { additionalProperties: true });

export const initProjectParameters = Type.Object({
  targetDir: Type.Optional(Type.String({ description: "目标项目目录，默认是当前工作目录" })),
  projectName: Type.Optional(Type.String({ description: "项目显示名称" })),
  description: Type.Optional(Type.String({ description: "项目定位" })),
  language: Type.Optional(Type.String({ description: "模板语言：zh-CN 或 en" })),
  testCommand: Type.Optional(Type.String({ description: "项目测试命令" })),
  dryRun: Type.Optional(Type.Boolean({ description: "只预览，不写入文件" })),
  roleModels: Type.Optional(roleModelsSchema),
});

export const roleNameSchema = Type.String({
  pattern: ROLE_ID_PATTERN.source,
  description: "要切换的角色 ID；必须是小写字母、数字和单连字符",
});

export const switchRoleParameters = Type.Object({ role: roleNameSchema });

export const workflowTaskRoleSchema = Type.String({
  pattern: ROLE_ID_PATTERN.source,
  description: "任务执行角色 ID；必须是小写字母、数字和单连字符，默认使用 developer-test",
});

const taskContractSchema = Type.Object({
  version: Type.Literal(1),
  outcome: Type.String({ description: "任务预期的业务结果" }),
  requirementSources: Type.Array(Type.String(), { minItems: 1, description: "需求来源及已接受事实出处；不要把推断写成来源" }),
  expectedBehavior: Type.Array(Type.String(), { minItems: 1, description: "对用户可观察的预期行为" }),
  evidence: Type.Array(Type.Object({ findingId: Type.String(), sourceId: Type.String(), sourceVersion: Type.String() }), {
    description: "必须是当前协调状态中明确接受且来源版本匹配的证据引用",
  }),
  fixedDecisions: Type.Array(Type.String(), { description: "已确认决策；没有则显式给空数组" }),
  invariants: Type.Array(Type.String(), { description: "实现不得破坏的不变量；没有则显式给空数组" }),
  nonGoals: Type.Array(Type.String(), { description: "明确排除的目标；没有则显式给空数组" }),
  blockingQuestions: Type.Array(Type.String(), { description: "影响正确性/验收的未决问题；不为空时计划不就绪" }),
  engineeringDiscretion: Type.Array(Type.String(), { description: "开发者可自主决定的普通、可逆工程细节" }),
  verification: Type.Array(Type.String(), { description: "本任务实际需要的验证；没有则显式给空数组" }),
  clarificationResolutions: Type.Array(Type.Object({
    issueId: Type.String(),
    resolutionKind: StringEnum(["evidence", "contract", "decision"] as const),
    resolution: Type.String(),
    sideEffectDisposition: StringEnum(["none", "reconciled", "no-replay"] as const),
  }), { description: "重规划时逐项回应此前澄清；无澄清时为空数组" }),
}, {
  description: "结构化任务契约。只在存在与当前 workflow revision 绑定、已接受且未过期的协调证据时允许携带，evidence 必须引用该账本中的已接受来源；普通任务保持无 contract 路径，不因协调协议被强制升级。",
});

export const workflowTaskSchema = Type.Object({
  id: Type.String({ description: "唯一任务 ID，小写字母、数字、点、下划线或连字符" }),
  task: Type.String({ description: "任务目标和实现范围" }),
  files: Type.Array(Type.String(), {
    minItems: 1,
    description: "任务允许涉及的文件或目录，用于约束实现范围",
  }),
  acceptanceCriteria: Type.Array(Type.String(), {
    minItems: 1,
    description: "任务完成前必须满足的验收标准",
  }),
  role: Type.Optional(workflowTaskRoleSchema),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "必须先完成的任务 ID" })),
  contract: Type.Optional(taskContractSchema),
});

const coordinationIdentitySchema = Type.Object({
  coordinationId: Type.String({ description: "持久协作记录 ID" }),
  coordinationVersion: Type.Integer({ minimum: 1, description: "协作协议版本" }),
  sessionId: Type.String({ description: "当前 Pi session 身份" }),
  recoveryGeneration: Type.Integer({ minimum: 0, description: "当前协作恢复代次" }),
  requestId: Type.String({ description: "当前证据请求 ID" }),
  role: StringEnum(["docs-commit", "architect"] as const, { description: "派发的协作角色" }),
  kind: StringEnum(["evidence", "review"] as const, { description: "当前协作 handoff 类型" }),
  attemptId: Type.String({ description: "当前协作 attempt 身份" }),
  handoffId: Type.String({ description: "当前协作 handoff 身份" }),
  reportId: Type.Optional(Type.String({ description: "当前待审阅的报告 ID" })),
});

const evidenceRequestSchema = Type.Object({
  requestId: Type.Optional(Type.String()),
  questionId: Type.String({ description: "稳定的问题 ID" }),
  question: Type.String({ description: "需要由取证明确回答的问题" }),
  rationale: Type.String({ description: "为什么此问题影响架构或开发就绪" }),
  scope: Type.Array(Type.String(), { minItems: 1, description: "必须核对的文件、符号、调用方或测试范围" }),
  exclusions: Type.Optional(Type.Array(Type.String())),
  completionCriteria: Type.Array(Type.String(), { minItems: 1, description: "取证完成条件" }),
  addressesGaps: Type.Optional(Type.Array(Type.String(), { description: "明确回应 more 审阅指出的缺口" })),
  followUpOfRequestId: Type.Optional(Type.String()),
  refreshReason: Type.Optional(Type.String({ description: "重新核实已接受证据时的来源变化或理由" })),
});

const evidenceSourceSchema = Type.Object({
  id: Type.String(),
  location: Type.String(),
  version: Type.String({ description: "来源版本、内容指纹或可复核的当前基线" }),
});

const evidenceReportSchema = Type.Object({
  reportId: Type.Optional(Type.String()),
  requestId: Type.String(),
  findings: Type.Array(Type.Object({
    findingId: Type.String(),
    questionId: Type.String(),
    classification: StringEnum(["fact", "inference", "unconfirmed", "conflict"] as const),
    statement: Type.String(),
    sources: Type.Array(evidenceSourceSchema),
  }), { description: "逐问题列出事实、推断、未确认项或冲突；每项注明来源" }),
  inspectedScope: Type.Array(Type.String(), { minItems: 1 }),
  testsLocated: Type.Optional(Type.Array(Type.String(), { description: "已定位但未必逐行阅读的测试" })),
  testsRun: Type.Optional(Type.Array(Type.Object({ command: Type.String(), result: Type.String() }), {
    description: "实际执行的检查命令及结果；未运行时留空，不得伪称通过",
  })),
  unresolved: Type.Optional(Type.Array(Type.String())),
});

const workflowTaskClarificationSchema = Type.Object({
  category: StringEnum(["missing-fact", "contract-conflict", "business-decision"] as const),
  question: Type.String({ description: "具体缺失事实、契约冲突或业务决策问题" }),
  impact: Type.String({ description: "为何影响当前任务结果或正确性" }),
  checkedFacts: Type.Array(Type.String(), { description: "开发者已核查的观察；不自动成为 architect 接受的证据" }),
  completedWork: Type.Array(Type.String(), { description: "已经完成的改动或可保留成果" }),
  verification: Type.Array(Type.String(), { description: "实际执行过的验证及结果；未运行时为空数组" }),
  sideEffects: Type.Object({
    status: StringEnum(["none", "occurred", "unknown"] as const),
    details: Type.Array(Type.String(), { description: "可能、已发生或已核实无影响的副作用说明" }),
  }),
});

const evidenceReviewSchema = Type.Object({
  reviewId: Type.Optional(Type.String()),
  reportId: Type.String(),
  decision: StringEnum(["accept", "more", "block"] as const),
  acceptedEvidence: Type.Optional(Type.Array(Type.Object({ findingId: Type.String(), sourceId: Type.String(), sourceVersion: Type.String() }))),
  gaps: Type.Optional(Type.Array(Type.String())),
  reason: Type.Optional(Type.String()),
});

export const taskWorkflowParameters = Type.Object({
  action: StringEnum(["plan", "status", "complete", "block", "clarify", "replan", "resume", "retry", "cancel", "request-evidence", "report-evidence", "review-evidence"] as const, {
    description: "工作流或架构协作动作",
  }),
  coordinationIdentity: Type.Optional(coordinationIdentitySchema),
  coordinationHandoffId: Type.Optional(Type.String({
    description: "当前运行时签发的协作 handoff 短引用；需要身份的协调动作（report-evidence、review-evidence、后续 request-evidence）可用它替代完整 coordinationIdentity。缺失引用不会套用当前状态；两种输入同时提供时必须指向同一 handoff。",
  })),
  request: Type.Optional(evidenceRequestSchema),
  report: Type.Optional(evidenceReportSchema),
  review: Type.Optional(evidenceReviewSchema),
  clarification: Type.Optional(workflowTaskClarificationSchema),
  summary: Type.Optional(Type.String({ description: "架构规划摘要（plan/replan 必填）" })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "架构约束和不可改变的决定" })),
  revisionId: Type.Optional(Type.String({ description: "当前待应用重规划的 revisionId（replan 必填）" })),
  retainTaskIds: Type.Optional(Type.Array(Type.String(), { description: "重规划时保留的未开始任务 ID" })),
  tasks: Type.Optional(Type.Array(workflowTaskSchema, {
    minItems: 1,
    description: `按顺序拆分的开发测试任务，建议不超过 ${WORKFLOW_RECOMMENDED_TASKS} 个（软建议，不是硬上限）`,
  })),
  reviewRequired: Type.Optional(Type.Boolean({
    description: "只有用户一开始明确要求先审阅架构时才设为 true；默认 false 自动推进",
  })),
  taskId: Type.Optional(Type.String({ description: "当前任务或要重试的任务 ID" })),
  workflowId: Type.Optional(Type.String({ description: "当前工作流身份；complete/block/replan 及其他变更动作必填" })),
  planVersion: Type.Optional(Type.Integer({ minimum: 0, description: "当前工作流计划版本；变更动作必填" })),
  sessionId: Type.Optional(Type.String({ description: "当前 Pi session 身份；变更动作必填" })),
  recoveryGeneration: Type.Optional(Type.Integer({ minimum: 0, description: "当前恢复代次；变更动作必填" })),
  attemptId: Type.Optional(Type.String({ description: "当前任务 attempt 身份（complete/block 必填）" })),
  handoffId: Type.Optional(Type.String({ description: "当前任务/replan handoff 身份" })),
  confirmUnknownOutcome: Type.Optional(Type.Boolean({ description: "旧执行结果未知时，外部副作用已核对并明确授权创建新 attempt" })),
  completionSummary: Type.Optional(Type.String({ description: "完成任务的实现摘要" })),
  implementationRationale: Type.Optional(Type.String({ description: "为什么采用该实现；必须说明关键取舍或约束" })),
  verification: Type.Optional(Type.Array(Type.String(), { description: "实际执行过的验证命令和结果" })),
  reason: Type.Optional(Type.String({ description: "阻塞原因（block 必填）" })),
});
