// Classification only: each caller retains its own authorization/progress policy.
const CORE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export function isCoreReadOnlyTool(toolName: string): boolean {
  return CORE_READ_ONLY_TOOLS.has(toolName);
}
