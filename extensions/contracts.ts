import { StringEnum } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROLE_ID_PATTERN, THINKING_LEVELS, WORKFLOW_MODES } from "../src/roles.ts";
import type { RoleModelConfig } from "../src/role-types.ts";
export type { ResolvedRoleConfig, RoleModelConfig } from "../src/role-types.ts";
import { WORKFLOW_RECOMMENDED_TASKS } from "../src/workflow.ts";

export type RunTimingEntryData = {
  source?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
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
    maximum: 3,
    description: "角色模型配置版本；当前保存版本为 3（统一全自动）",
  })),
  modelStrategy: Type.Optional(StringEnum(["roles", "auto"] as const, {
    description: "模型策略：roles 自动使用角色映射；auto 固定模型并自动调整推理强度。两套配置互相保留",
  })),
  autoModel: Type.Optional(Type.Object({
    provider: Type.String({ description: "固定模型提供商 ID" }),
    model: Type.String({ description: "固定模型 ID" }),
    initialThinkingLevel: StringEnum(THINKING_LEVELS),
    minThinkingLevel: StringEnum(THINKING_LEVELS),
    maxThinkingLevel: StringEnum(THINKING_LEVELS),
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

export const switchRoleParameters = Type.Object({
  role: roleNameSchema,
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Auto 任务入口显式评估的强度，保持当前强度也需提交；仅影响后续请求，role 必须是当前职责，不同时换角" })),
  reason: Type.Optional(Type.String({ description: "Auto 评估的复杂度或风险依据，保持也需理由；最多 1000 字符，不含敏感信息，作为数据记录而非系统指令" })),
  taskBoundary: Type.Optional(Type.Boolean({ description: "仅普通会话的新用户输入确实引入独立任务时设为 true；继续或补充说明不是新任务，工作流边界由运行时决定" })),
});

export const workflowTaskRoleSchema = Type.String({
  pattern: ROLE_ID_PATTERN.source,
  description: "任务执行角色 ID；必须是小写字母、数字和单连字符，默认使用 developer-test",
});
export const workflowTaskSchema = Type.Object({
  id: Type.String({ description: "唯一任务 ID，小写字母、数字、点、下划线或连字符" }),
  task: Type.String({ description: "一个可独立验收的交付物及非目标；不按读取/修改/测试机械拆任务，执行者在范围内自主闭环" }),
  files: Type.Array(Type.String(), {
    minItems: 1,
    description: "任务定位与预估涉及的文件或目录；目标、验收和公共契约不变时可补必要直接关联文件，无需仅因此重规划。明确的禁止、隔离与权限边界仍须遵守",
  }),
  acceptanceCriteria: Type.Array(Type.String(), {
    minItems: 1,
    description: "当前交付物与按风险选择的验证；区分当前验收和后续系统/人工验收，真实指实际执行，不默认真机或全链路。已有必需验收不得自行降级，来源未变时复用有效结果",
  }),
  role: Type.Optional(workflowTaskRoleSchema),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "必须先完成的任务 ID" })),
  goalId: Type.Optional(Type.String({ description: "已有目标归属，仅影响分组展示，不建立父子执行栈" })),
  priority: Type.Optional(Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: "同一队列中依赖已满足任务的优先级；越大越优先，相同保持顺序" })),
});
export const taskWorkflowParameters = Type.Object({
  action: StringEnum(["plan", "status", "checkpoint", "complete", "block", "replan", "resume", "retry", "cancel", "cancel-all", "request-replan", "request-goal"] as const, { description: "扁平任务工作流动作；不提供正式取证、契约澄清或嵌套执行协议" }),
  orchestration: Type.Optional(StringEnum(["required"] as const, { description: "仅plan：需要持久检查点、恢复或职责调度时设为required，使auto下的一至两项计划也进入工作流；省略沿用原数量策略，off仍拒绝规划，不授予恢复或执行权限" })),
  detail: Type.Optional(StringEnum(["summary", "full"] as const, { description: "status默认summary返回当前进度、阻塞与下一步；full按需查看完整规划、任务历史、身份和任务记忆" })),
  checkpoint: Type.Optional(Type.Object({
    step: Type.String({ minLength: 1, maxLength: 200 }),
    accomplished: Type.Array(Type.Object({ summary: Type.String({ minLength: 1, maxLength: 512 }), evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 8, description: "本任务真实工具结果的来源ID；缺少已知有效ID时按需一次status(detail=full)，取任务记忆observations[].id并核对outcome，不用toolCallId、messageEntryId或obs_recall ID替代；已有可核验来源可复用" }) }), { maxItems: 16, description: "每项成果至少引用一个真实来源；没有成果条目时可传[]，不为凑来源执行额外工具" }),
    remaining: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
    blockers: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 16 }),
    nextStep: Type.String({ minLength: 1, maxLength: 512 }),
  })),
  expectedMemoryRevision: Type.Optional(Type.Integer({ minimum: 0, description: "checkpoint必填；复用已知当前任务记忆revision或缺失字段错误给出的值。确需读取时一次status(detail=full)取得revision；版本陈旧须先核对最新checkpoint并合并有效进展，不只换数字覆盖" })),
  memoryFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 16, description: "checkpoint声明的项目相对文件；内容hash不证明完整验证依赖" })),
  evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 8, description: "status读取当前任务或已完成直接依赖的声明来源；complete可引用本任务成功工具结果。仅证明历史观察，不证明需求全部满足或当前版本有效" })),
  parentGoalId: Type.Optional(Type.String({ description: "目标归属ID，只分组、不创建执行栈" })),
  summary: Type.Optional(Type.String({ description: "规划摘要或修正方向" })),
  constraints: Type.Optional(Type.Array(Type.String(), { description: "已确认的目标、非目标及硬约束；明确禁止修改、隔离与权限边界不可越过。普通文件预估放files，不将helper、调用方、测试或构建接线细节写成额外审批条件" })),
  revisionId: Type.Optional(Type.String()),
  retainTaskIds: Type.Optional(Type.Array(Type.String(), { description: "replan时仅填写需要原样保留的pending任务ID；已完成任务自动保留，不要填入" })),
  tasks: Type.Optional(Type.Array(workflowTaskSchema, { minItems: 0, description: "依赖优先的顺序任务；建议不超过 " + WORKFLOW_RECOMMENDED_TASKS + " 项，不是硬上限；replan时仅放新增或替换任务，须使用未出现过的新ID，并同步更新依赖" })),
  reviewRequired: Type.Optional(Type.Boolean({ description: "仅用户明确要求先审阅规划时设置" })),
  taskId: Type.Optional(Type.String()),
  workflowId: Type.Optional(Type.String()),
  planVersion: Type.Optional(Type.Integer({ minimum: 0 })),
  sessionId: Type.Optional(Type.String()),
  recoveryGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
  attemptId: Type.Optional(Type.String()),
  handoffId: Type.Optional(Type.String()),
  confirmUnknownOutcome: Type.Optional(Type.Boolean({ description: "模型布尔值不构成未知结果重放授权，必须由用户命令或面板确认" })),
  completionSummary: Type.Optional(Type.String()),
  implementationRationale: Type.Optional(Type.String()),
  verification: Type.Optional(Type.Array(Type.String(), { description: "complete时必填且非空，记录当前确认验收所需的实际检查及结果；只读调查可填写静态核对。后续系统/人工验收另列待办，不得将未执行检查描述为通过" })),
  outcomeUnknown: Type.Optional(Type.Boolean({ description: "block时报告已执行操作或副作用结果未知；尚未验证或等待人工验收不属于此状态。仅增加保护，不授权清除未知状态或自动重试" })),
  reason: Type.Optional(Type.String()),
});
