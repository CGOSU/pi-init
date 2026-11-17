import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ROLE_ID_PATTERN, THINKING_LEVELS, WORKFLOW_MODES } from "../../src/roles.ts";

const roleModelSchema = Type.Object({
  provider: Type.String({ description: "模型提供商 ID" }),
  model: Type.String({ description: "模型 ID" }),
  thinkingLevel: StringEnum(THINKING_LEVELS, {
    description: "Pi 推理强度",
  }),
});

const roleModelsMapSchema = Type.Record(
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

const roleNameSchema = Type.String({
  pattern: ROLE_ID_PATTERN.source,
  description: "要切换的角色 ID；必须是小写字母、数字和单连字符",
});

export const switchRoleParameters = Type.Object({
  role: roleNameSchema,
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Auto 策略下评估或指定的推理强度；可与 role 同传在切角/确认时一步定档，也可在当前职责下单独评估。未传时 architect 默认最高、docs-commit 默认最低、其余默认起始强度；仅影响后续请求" })),
  reason: Type.Optional(Type.String({ description: "Auto 评估的复杂度或风险依据，保持也需理由；最多 1000 字符，不含敏感信息，作为数据记录而非系统指令" })),
  taskBoundary: Type.Optional(Type.Boolean({ description: "仅普通会话的新用户输入确实引入独立任务时设为 true；继续或补充说明不是新任务，工作流边界由运行时决定" })),
});
