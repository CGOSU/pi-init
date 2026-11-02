import { realpathSync, readFileSync, statSync } from "node:fs";
import { SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./role-context-protocol.ts";
import type { HandoffResult } from "../src/general-session-handoff.ts";

export function readHandoffArchive(file: string, root: string, sessionId: string): HandoffResult<SessionManager> {
  const fail = (code: string, message: string): HandoffResult<never> => ({ ok: false, code, message });
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return fail("FILE_TYPE", "来源不是普通session文件");
    if (stats.size === 0) return fail("EMPTY", "来源session文件为空");
    const text = readFileSync(file, "utf8");
    let entries;
    try { entries = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)); }
    catch { return fail("PARSE", "session JSONL解析失败，可能尚未完整保存"); }
    const header = entries[0];
    if (!isRecord(header) || header.type !== "session" || header.id !== sessionId || typeof header.cwd !== "string") return fail("IDENTITY", "来源session身份不匹配");
    if (realpathSync(header.cwd) !== root) return fail("PROJECT", "来源session项目不匹配");
    return { ok: true, value: SessionManager.inMemory(root, undefined, entries) };
  } catch (error) { return fail("PERSISTENCE", "无法读取session文件：" + String(error)); }
}

type ReplacementContext = Parameters<NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>>[0];

/** One replacement lifecycle for both background and workflow transfers. Never use the old context after replacement. */
export async function replaceHandoffSession(ctx: ExtensionCommandContext, options: {
  sourceFile: string;
  setup: (manager: SessionManager) => Promise<void> | void;
  activate: (ctx: ReplacementContext) => Promise<void>;
  cancel: () => void;
  uncertain: () => void;
}) {
  let setupRan = false;
  let activated = false;
  try {
    const result = await ctx.newSession({
      parentSession: options.sourceFile,
      setup: async manager => { setupRan = true; await options.setup(manager); },
      withSession: async next => { await options.activate(next); activated = true; },
    });
    if (result.cancelled && !setupRan) { options.cancel(); return; }
    if (!setupRan || !activated) options.uncertain();
  } catch { options.uncertain(); }
}
