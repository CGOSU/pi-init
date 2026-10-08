export type RoleMode = "auto" | "confirm" | "manual";
export type WorkflowMode = "off" | "on" | "auto";
export type WorkflowExecutor = "local";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DefaultRoleName = "architect" | "developer-test" | "docs-commit";

export type RoleModelConfig = {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
};

export type ResolvedRoleConfig = {
  schemaVersion: number;
  mode: RoleMode;
  workflowMode: WorkflowMode;
  workflowExecutor: WorkflowExecutor;
  roleModels: Record<string, RoleModelConfig>;
};

export type ModelReference = {
  provider: string;
  model: string;
};

export type RoleModelOption = {
  provider: string;
  id: string;
  name?: string;
};

export type RoleConfigFailure = {
  ok: false;
  code: string;
  message: string;
};

export type RoleConfigResult<T> = { ok: true; value: T } | RoleConfigFailure;
