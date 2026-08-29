import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ROLE_ID_PATTERN, THINKING_LEVELS, WORKFLOW_EXECUTORS, WORKFLOW_MODES } from "../src/roles.js";
import { WORKFLOW_MAX_TASKS } from "../src/workflow.js";

export type RoleModelConfig = {
  provider: string;
  model: string;
  thinkingLevel: string;
};

export type RunTimingEntryData = {
  source?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};

export type ReportTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

export type ResolvedRoleConfig = {
  schemaVersion: number;
  mode: string;
  workflowMode: string;
  workflowExecutor: string;
  roleModels: Record<string, RoleModelConfig>;
};

export type MenuItem = {
  value: string;
  label: string;
  description?: string;
};

export type MenuOptions = {
  summary?: string[];
  maxVisible?: number;
  selectedValue?: string;
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
  workflowExecutor: Type.Optional(StringEnum(WORKFLOW_EXECUTORS, {
    description: "工作流执行器：local 或 subtask；默认 local",
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
});

export const taskWorkflowParameters = Type.Object({
  action: StringEnum(["plan", "status", "complete", "block", "replan", "resume", "retry", "cancel"] as const, {
    description: "工作流动作",
  }),
  summary: Type.Optional(Type.String({ description: "架构规划摘要（plan/replan 必填）" })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "架构约束和不可改变的决定" })),
  revisionId: Type.Optional(Type.String({ description: "当前待应用重规划的 revisionId（replan 必填）" })),
  retainTaskIds: Type.Optional(Type.Array(Type.String(), { description: "重规划时保留的未开始任务 ID" })),
  tasks: Type.Optional(Type.Array(workflowTaskSchema, {
    minItems: 1,
    maxItems: WORKFLOW_MAX_TASKS,
    description: `按顺序拆分的开发测试任务，最多 ${WORKFLOW_MAX_TASKS} 个`,
  })),
  reviewRequired: Type.Optional(Type.Boolean({
    description: "只有用户一开始明确要求先审阅架构时才设为 true；默认 false 自动推进",
  })),
  taskId: Type.Optional(Type.String({ description: "当前任务或要重试的任务 ID" })),
  completionSummary: Type.Optional(Type.String({ description: "完成任务的实现摘要" })),
  verification: Type.Optional(Type.Array(Type.String(), { description: "实际执行过的验证命令和结果" })),
  reason: Type.Optional(Type.String({ description: "阻塞原因（block 必填）" })),
});
