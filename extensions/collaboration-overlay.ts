import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listActiveAgents } from "./collaboration-registry.ts";
import { readMessageLogTail } from "./collaboration-messages.ts";
import { listRuns } from "./collaboration-runs.ts";
import type { CollaborationDirs } from "./collaboration-types.ts";

function displayName(name: string): string {
  const match = name.match(/-([A-Z][a-z]+[A-Z][A-Za-z]+)$/);
  return match?.[1] ?? name;
}

class AgentsOverlay {
  private readonly dirs: CollaborationDirs;
  private readonly selfName: string;
  private readonly done: (value?: unknown) => void;
  private readonly theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string };
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    dirs: CollaborationDirs,
    selfName: string,
    done: (value?: unknown) => void,
    theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string },
    requestRender: () => void,
  ) {
    this.dirs = dirs;
    this.selfName = selfName;
    this.done = done;
    this.theme = theme;
    this.refreshTimer = setInterval(requestRender, 1000);
    this.refreshTimer.unref?.();
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
  }

  render(_width: number): string[] {
    const agents = listActiveAgents(this.dirs);
    const messages = readMessageLogTail(this.dirs, 8);
    const runs = listRuns(this.dirs, { parentAgent: this.selfName });
    const color = (name: string, text: string) => this.theme.fg?.(name, text) ?? text;
    const lines = [
      color("accent", this.theme.bold?.("Agents") ?? "Agents"),
      "",
      ...agents.map((agent) => {
        const reservationCount = agent.reservations?.length ?? 0;
        const role = agent.role ? ` (${agent.role})` : "";
        const lock = reservationCount > 0 ? ` 🔒${reservationCount}` : "";
        return `• ${displayName(agent.name)}${role}${lock} · ${agent.cwd}`;
      }),
    ];
    if (agents.length === 0) lines.push(color("muted", "(no active agents)"));
    lines.push("", color("accent", "Recent messages"));
    lines.push(...(messages.length > 0 ? messages.map((event) => `• ${event.from} → ${event.to}: ${event.text}`) : [color("muted", "(no messages)")]));
    lines.push("", color("accent", "Recent runs"));
    lines.push(...(runs.length > 0 ? runs.slice(0, 8).map((run) => `• ${run.recordId} · ${run.status} · ${run.taskPreview}`) : [color("muted", "(no subagent runs)")]));
    lines.push("", color("dim", "Esc/q 关闭"));
    return lines;
  }

  handleInput(data: string): void {
    if (data === "\u001b" || data === "q" || data === "Q" || data === "\u0003") this.done(undefined);
  }
}

export async function openAgentsOverlay(ctx: ExtensionContext, dirs: CollaborationDirs, selfName: string): Promise<void> {
  if (!ctx.hasUI || !ctx.ui.custom) {
    ctx.ui.notify("当前上下文不支持 Agents Overlay；请使用 agent_message action=list 或 status。", "warning");
    return;
  }
  let overlay: AgentsOverlay | undefined;
  try {
    await ctx.ui.custom(
      (tui: { requestRender?: () => void }, theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string }, _kb: unknown, done: (value?: unknown) => void) => {
        overlay = new AgentsOverlay(dirs, selfName, done, theme, () => tui.requestRender?.());
        return overlay;
      },
      { title: "Agents", overlay: true },
    );
  } finally {
    overlay?.dispose();
  }
}
