import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ROLE_ID_PATTERN } from "../../src/roles.ts";
import { TASK_MEMORY_LIMITS } from "../../src/task-memory-protocol.ts";
import { WORKFLOW_RECOMMENDED_TASKS } from "../../src/workflow.ts";

const workflowTaskRoleSchema = Type.String({
  pattern: ROLE_ID_PATTERN.source,
  description: "任务执行角色 ID；必须是小写字母、数字和单连字符，默认使用 developer-test",
});
const workflowTaskSchema = Type.Object({
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
    step: Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.stepLength }),
    accomplished: Type.Array(Type.Object({ summary: Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.textLength }), evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.evidenceIdLength }), { minItems: 1, maxItems: TASK_MEMORY_LIMITS.evidencePerAccomplishment, description: "本任务真实工具结果的来源ID；缺少已知有效ID时按需一次status(detail=full)，取任务记忆observations[].id并核对outcome，不用toolCallId、messageEntryId或obs_recall ID替代；已有可核验来源可复用" }) }), { maxItems: TASK_MEMORY_LIMITS.accomplishments, description: "每项成果至少引用一个真实来源；没有成果条目时可传[]，不为凑来源执行额外工具" }),
    remaining: Type.Array(Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.textLength }), { maxItems: TASK_MEMORY_LIMITS.remaining }),
    blockers: Type.Array(Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.textLength }), { maxItems: TASK_MEMORY_LIMITS.blockers }),
    nextStep: Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.textLength }),
  })),
  expectedMemoryRevision: Type.Optional(Type.Integer({ minimum: 0, description: "checkpoint必填；复用已知当前任务记忆revision或缺失字段错误给出的值。确需读取时一次status(detail=full)取得revision；版本陈旧须先核对最新checkpoint并合并有效进展，不只换数字覆盖" })),
  memoryFiles: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.textLength }), { maxItems: TASK_MEMORY_LIMITS.files, description: "checkpoint声明的项目相对文件；内容hash不证明完整验证依赖" })),
  evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TASK_MEMORY_LIMITS.evidenceIdLength }), { maxItems: TASK_MEMORY_LIMITS.evidencePerRequest, description: "status读取当前任务或已完成直接依赖的声明来源；complete可引用本任务成功工具结果。仅证明历史观察，不证明需求全部满足或当前版本有效" })),
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
  verification: Type.Optional(Type.Array(Type.Object({
    check: Type.String({ minLength: 1, description: "可识别的实际检查项或完整验证命令" }),
    status: StringEnum(["passed", "failed", "not-run"] as const),
    details: Type.String({ minLength: 1, description: "真实结果、失败原因或未执行原因；不得用说明文字覆盖 status" }),
  }, { additionalProperties: false }), { minItems: 1, description: "complete时必填的结构化验证记录。passed=通过，failed=失败，not-run=未执行；仅按status识别结果。后续人工/系统验收可明确未执行，不等同副作用结果未知，也不新增所有记录均须通过的规则。历史文字不能作为新验证输入。" })),
  outcomeUnknown: Type.Optional(Type.Boolean({ description: "block时报告已执行操作或副作用结果未知；尚未验证或等待人工验收不属于此状态。仅增加保护，不授权清除未知状态或自动重试" })),
  reason: Type.Optional(Type.String()),
});
