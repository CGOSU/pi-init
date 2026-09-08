import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARCHITECT_ROLE = "architect";
const ALLOWED_TOOLS = new Set([
  "switch_role",
  "task_workflow",
  "read",
  "grep",
  "find",
  "ls",
  "ffgrep",
  "fffind",
]);
const SAFE_BROWSER_ACTIONS = new Set(["open", "snapshot", "get", "wait", "scroll", "screenshot"]);
const SAFE_BROWSER_GET_TYPES = new Set(["text", "url", "title"]);
const SAFE_BROWSER_SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const ARCHITECT_BOUNDARY_REASON =
  "[pi-init-architect-boundary] 架构师可进行受限只读定位和浏览观察，但不得修改文件、执行命令、调用外部写入或未知工具；需要实现或复杂取证时请调用 switch_role。";
const BROWSER_BOUNDARY_REASON =
  "[pi-init-architect-boundary] 架构师仅可使用 browser 的 open、snapshot、get、wait、scroll、screenshot 观察命令；交互、持久化、关闭浏览器、脚本和命令串联请先调用 switch_role。";

function tokenizeBrowserCommand(command: unknown): string[] | undefined {
  if (typeof command !== "string" || command.trim().length === 0) return undefined;

  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasValue = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\0" || char === "\n" || char === "\r" || char === "`" || (char === "$" && command[index + 1] === "(")) {
      return undefined;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
        hasValue = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasValue = true;
    } else if (/\s/.test(char)) {
      if (hasValue) {
        parts.push(current);
        current = "";
        hasValue = false;
      }
    } else if (char === ";" || char === "|" || char === "&") {
      return undefined;
    } else {
      current += char;
      hasValue = true;
    }
  }

  if (quote) return undefined;
  if (hasValue) parts.push(current);
  return parts;
}

function isBrowserReference(value: string | undefined): boolean {
  return Boolean(value && /^@[a-z0-9_-]+$/i.test(value));
}

function isSafeBrowserCommand(input: unknown): boolean {
  if (!input || typeof input !== "object" || !("command" in input)) return false;
  const parts = tokenizeBrowserCommand((input as { command?: unknown }).command);
  if (!parts) return false;

  const [action, option, value] = parts;
  if (!SAFE_BROWSER_ACTIONS.has(action.toLowerCase())) return false;

  switch (action.toLowerCase()) {
    case "open":
      return parts.length === 2 && /^https?:\/\//i.test(option);
    case "snapshot":
      return parts.length === 1 || (parts.length === 2 && option === "-i");
    case "get":
      return parts.length === 2 || (parts.length === 3 && isBrowserReference(value))
        ? SAFE_BROWSER_GET_TYPES.has(option.toLowerCase())
        : false;
    case "wait":
      return parts.length === 2 && (isBrowserReference(option) || /^\d+$/.test(option));
    case "scroll":
      return (parts.length === 2 || parts.length === 3)
        && SAFE_BROWSER_SCROLL_DIRECTIONS.has(option.toLowerCase())
        && (parts.length === 2 || /^\d+$/.test(value));
    case "screenshot":
      return parts.length === 1 || (parts.length === 2 && option === "--full");
    default:
      return false;
  }
}

export function createArchitectBoundary(
  pi: ExtensionAPI,
  getActiveRole: (ctx: ExtensionContext) => string | undefined,
) {
  pi.on("tool_call", (event, ctx) => {
    if (getActiveRole(ctx) !== ARCHITECT_ROLE) return undefined;
    if (ALLOWED_TOOLS.has(event.toolName)) return undefined;
    if (event.toolName === "browser" && isSafeBrowserCommand(event.input)) return undefined;

    return {
      block: true,
      reason: event.toolName === "browser" ? BROWSER_BOUNDARY_REASON : ARCHITECT_BOUNDARY_REASON,
    };
  });
}
