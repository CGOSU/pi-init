import {
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  WORKFLOW_AUTO_TASK_LIMIT,
  WORKFLOW_MODES,
} from "./role-config-definitions.js";
import { normalizeRoleModels } from "./role-config.js";

export {
  ROLE_MODES,
  DEFAULT_ROLE_MODE,
  WORKFLOW_MODES,
  DEFAULT_WORKFLOW_MODE,
  WORKFLOW_EXECUTORS,
  DEFAULT_WORKFLOW_EXECUTOR,
  WORKFLOW_AUTO_TASK_LIMIT,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  ROLE_CONFIG_SCHEMA_VERSION,
  ROLE_ID_PATTERN,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  roleLabel,
  roleModeLabel,
  isValidRoleId,
  normalizeRoleId,
  normalizeModelReference,
  DEFAULT_ROLE_MODELS,
  DEFAULT_ROLE_NAMES,
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_TIER_CONFIG,
  THINKING_LEVELS,
} from "./role-config-definitions.js";

export {
  getRoleNames,
  isRoleConfigured,
  resolveRoleMode,
  resolveWorkflowMode,
  resolveWorkflowExecutor,
  resolveRuntimeConfig,
  resolveRoleModel,
  mergeRoleConfig,
  resolveRoleConfig,
  serializeRoleConfig,
} from "./role-config.js";

export function shouldCompactOnRoleSwitch({ mode, previousRole, nextRole, contextUsage }) {
  return (
    mode === "auto" &&
    typeof previousRole === "string" &&
    previousRole !== nextRole &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function shouldCompactAfterWorkflowTask({ mode, contextUsage }) {
  return (
    mode === "auto" &&
    contextUsage?.percent != null &&
    contextUsage.percent >= ROLE_SWITCH_COMPACTION_THRESHOLD
  );
}

export function findMatchingRole(config, model, thinkingLevel) {
  if (!model) return undefined;

  const roleModels = normalizeRoleModels(config);
  const matches = Object.keys(roleModels).filter((role) => {
    const value = roleModels[role];
    return (
      value.provider === model.provider &&
      value.model === model.id &&
      value.thinkingLevel === thinkingLevel
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function shouldOrchestrateWorkflow({ mode, taskCount }) {
  if (!WORKFLOW_MODES.includes(mode)) {
    throw new Error(`工作流模式 workflowMode 无效：${mode}`);
  }
  if (!Number.isInteger(taskCount) || taskCount < 1) {
    throw new Error(`工作流任务数无效：${taskCount}`);
  }

  return mode === "on" || (mode === "auto" && taskCount > WORKFLOW_AUTO_TASK_LIMIT);
}

export function filterRoleModels(models, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return models;

  return models.filter((model) =>
    `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
}
