import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { diagnosticDirectory, diagnosticErrorCode, withDiagnosticLock } from "./diagnostic-storage.ts";
import { isGlobalDiagnosticEvent } from "./global-diagnostics.ts";
import { showMenu, isMenuBack, MENU_BACK } from "./ui.ts";

type Scope = "project" | "global";
type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const names = ["runtime.jsonl.1", "runtime.jsonl"];
const labels = { project: "当前项目", global: "本机全局（所有项目）" };
const categories = new Set(["initialization", "command", "role-switch", "workflow-control", "runtime-recovery", "workflow-rejection", "outcome-unknown", "delivery", "business-rejection", "tool-failure", "provider-http", "assistant-failure", "compaction-failure", "suspected-loop", "suspected-slow", "context-budget", "runtime-failure", "delivery-failure", "suspected-stall"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function safeRecord(line: string): Result<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return { ok: false, code: "INVALID_DIAGNOSTIC_JSON", message: "诊断记录损坏或未写完整，请稍后重试。" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "INVALID_DIAGNOSTIC_RECORD", message: "诊断记录不是对象，未导出。" };
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["timestamp", "firstSeen", "lastSeen"]) {
    const value = source[key];
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))) result[key] = new Date(value).toISOString();
  }
  for (const key of ["count", "run", "dropped", "durationMs"]) if (typeof source[key] === "number" && Number.isFinite(source[key])) result[key] = source[key];
  if (typeof source.category === "string" && categories.has(source.category)) result.category = source.category;
  if (typeof source.event === "string" && isGlobalDiagnosticEvent(source.event)) result.event = source.event;
  if (["issue", "summary", "request", "cache-request"].includes(String(source.kind))) result.kind = source.kind;
  const trigger = source.latestTrigger as { data?: Record<string, unknown> } | undefined;
  for (const key of ["diagnosticEventId", "diagnosticProjectId", "diagnosticSessionId"]) {
    const value = source[key] ?? trigger?.data?.[key];
    if (typeof value === "string") result[key] = hash(value);
  }
  return { ok: true, value: result };
}

export function createDiagnosticControls(deps: {
  report: (ctx: ExtensionCommandContext) => Promise<string>;
  flush: () => Promise<unknown>;
  agentDir?: () => string;
}) {
  function location(ctx: ExtensionCommandContext, scope: Scope) {
    const root = scope === "project" ? ctx.cwd : (deps.agentDir ?? getAgentDir)();
    const parts = scope === "project" ? [".pi", "diagnostics"] : ["diagnostics", "pi-init"];
    return { root, parts, path: join(root, ...parts, "runtime.jsonl") };
  }
  function failure(error: unknown): Result<never> {
    const code = diagnosticErrorCode(error);
    const reasons: Record<string, string> = {
      RESERVED_DIAGNOSTIC_TARGET: "不能导出到诊断日志或活动锁路径。",
      EEXIST: "目标已经存在，不覆盖已有文件。", ENOENT: "目录或文件不存在，可能尚未产生诊断。",
      EACCES: "没有文件访问权限。", EPERM: "系统拒绝文件操作。", ENOSPC: "磁盘空间不足。",
      DIAGNOSTIC_LOCK_BUSY: "诊断正被使用或存在遗留锁，请核对后重试。",
      UNSAFE_DIAGNOSTIC_PATH: "目录或文件不是普通路径，拒绝跟随链接。",
      DIAGNOSTIC_TOO_LARGE: "诊断文件超过单文件 2 MiB 读取上限。",
      NO_DIAGNOSTIC_DATA: "没有可导出的诊断记录。",
      INVALID_DIAGNOSTIC_JSON: "诊断记录损坏或未写完整，请稍后重试。",
      INVALID_DIAGNOSTIC_RECORD: "诊断记录不是对象。",
    };
    return { ok: false, code, message: `诊断操作失败（${code}）：${reasons[code] ?? "请检查文件权限、目录及活动锁。"} 清理若中途失败，已删除的文件不会恢复；导出写入若失败，目标可能含不完整内容。` };
  }
  async function operate<T>(ctx: ExtensionCommandContext, scope: Scope, action: (directory: string) => Promise<T>): Promise<Result<T>> {
    if (scope !== "project" && scope !== "global") return { ok: false, code: "INVALID_SCOPE", message: "请选择当前项目或本机全局范围。" };
    if (!ctx.isProjectTrusted()) return { ok: false, code: "UNTRUSTED", message: "未信任项目，不能操作诊断文件。" };
    try {
      await deps.flush();
      const { root, parts } = location(ctx, scope);
      const directory = await diagnosticDirectory(root, parts);
      return { ok: true, value: await withDiagnosticLock(directory, () => action(directory)) };
    } catch (error) { return failure(error); }
  }
  async function regularFiles(directory: string) {
    const files: string[] = [];
    for (const name of names) {
      const file = join(directory, name);
      try {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("不安全的诊断文件"), { code: "UNSAFE_DIAGNOSTIC_PATH" });
        files.push(file);
      } catch (error) { if (diagnosticErrorCode(error) !== "ENOENT") throw error; }
    }
    return files;
  }
  async function exportFile(ctx: ExtensionCommandContext, scope: Scope, target: string): Promise<Result<{ path: string; count: number }>> {
    if (!target.trim()) return { ok: false, code: "MISSING_TARGET", message: "请提供导出目标文件路径。" };
    return operate(ctx, scope, async directory => {
      const records: Record<string, unknown>[] = [];
      for (const file of await regularFiles(directory)) {
        const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if ((await handle.stat()).size > 2 * 1024 * 1024) throw Object.assign(new Error("诊断文件超过读取上限"), { code: "DIAGNOSTIC_TOO_LARGE" });
          const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
            if (!bytesRead) break;
            length += bytesRead;
          }
          if (length === buffer.length) throw Object.assign(new Error("诊断文件超过读取上限"), { code: "DIAGNOSTIC_TOO_LARGE" });
          const text = buffer.subarray(0, length).toString("utf8");
          for (const line of text.split("\n").filter(Boolean)) {
            const record = safeRecord(line);
            if (!record.ok) throw Object.assign(new Error(record.message), { code: record.code });
            records.push(record.value);
            if (records.length > 256) records.shift();
          }
        } finally { await handle.close(); }
      }
      if (!records.length) throw Object.assign(new Error("没有可导出的诊断"), { code: "NO_DIAGNOSTIC_DATA" });
      const path = resolve(ctx.cwd, target);
      const parent = await fs.realpath(dirname(path));
      if (parent === directory && [...names, "runtime.lock"].includes(basename(path))) throw Object.assign(new Error("不能导出到诊断存储文件"), { code: "RESERVED_DIAGNOSTIC_TARGET" });
      await fs.writeFile(path, JSON.stringify({ version: 1, scope, limit: 256, records }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return { path, count: records.length };
    });
  }
  async function clear(ctx: ExtensionCommandContext, scope: Scope): Promise<Result<{ count: number }> | undefined> {
    if (scope !== "project" && scope !== "global") return { ok: false, code: "INVALID_SCOPE", message: "请选择当前项目或本机全局范围。" };
    if (!ctx.isProjectTrusted() || !ctx.hasUI) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "清理需要受信任项目和交互式确认，未删除文件。" };
    if (!await ctx.ui.confirm(`清理${labels[scope]}诊断？`, `目标：${location(ctx, scope).path} 及 .1 备份。删除后不可恢复，不影响工作流状态和会话文件；后续故障仍会重新记录。不处理旧版详细日志。是否确认？`)) return undefined;
    return operate(ctx, scope, async directory => {
      const files = await regularFiles(directory);
      for (const file of files) await fs.unlink(file);
      return { count: files.length };
    });
  }
  async function status(ctx: ExtensionCommandContext) {
    const lines = [await deps.report(ctx)];
    if (!ctx.isProjectTrusted()) return lines.join("\n");
    for (const scope of ["project", "global"] as const) {
      const result = await operate(ctx, scope, async directory => {
        const files = await regularFiles(directory);
        for (const file of files) {
          const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          await handle.close();
        }
        return files.length;
      });
      lines.push(`${labels[scope]}：${location(ctx, scope).path}（及 .1 备份）；${result.ok ? `可访问，${result.value} 个日志文件` : `不可访问或尚未生成：${result.code}`}。`);
    }
    lines.push("状态仅代表本次检查，不是跨进程健康证明。全局仅记录 pi-init 自身可观测故障，不覆盖加载前或宿主未暴露故障。导出不含正文、快照、消息、配置或工具内容；最多最近 256 条，关联标识再次哈希。旧版详细日志不在操作范围内。不会上传；清理后仍可能有新记录。遗留 runtime.lock 不会自动移除。未运行本版本的旧进程不共享维护锁，请先关闭旧实例。");
    return lines.join("\n");
  }
  async function command(args: string, ctx: ExtensionCommandContext) {
    const [action = "status", scope, ...destination] = args.trim().split(/\s+/).filter(Boolean);
    if (action === "status") { ctx.ui.notify(await status(ctx), "info"); return; }
    if (action === "menu") {
      if (!ctx.hasUI) { ctx.ui.notify("诊断面板需要交互式界面；可使用 /blackbox status。", "warning"); return; }
      const selected = await showMenu(ctx, "运行诊断", [
        { value: "status", label: "查看项目与全局状态" },
        { value: "export", label: "导出有限脱敏诊断", description: "仅本机写入新文件，不上传，不覆盖已有文件" },
        { value: "clear", label: "清理诊断日志", description: "选择范围后再次确认；不清理工作流或会话" },
        { value: MENU_BACK, label: "← 返回" },
      ]);
      if (!selected || isMenuBack(selected)) return;
      if (selected === "status") return command("status", ctx);
      const range = await showMenu(ctx, "选择诊断范围", [
        { value: "project", label: labels.project }, { value: "global", label: labels.global }, { value: MENU_BACK, label: "← 取消" },
      ]);
      if (!range || isMenuBack(range)) { ctx.ui.notify("已取消，未导出或清理文件。", "info"); return; }
      const target = selected === "export" ? await ctx.ui.input("导出到新文件", "输入目标路径，不覆盖已有文件") : "";
      if (selected === "export" && !target?.trim()) { ctx.ui.notify("已取消，未导出文件。", "info"); return; }
      return command(`${selected} ${range} ${target}`, ctx);
    }
    if ((action !== "export" && action !== "clear") || (scope !== "project" && scope !== "global") || action === "clear" && destination.length) {
      ctx.ui.notify("用法：/blackbox [status|menu|export <project|global> <新文件路径>|clear <project|global>]；project 为当前项目，global 为本机全部项目。清理必须交互确认。", "warning"); return;
    }
    const result = action === "export" ? await exportFile(ctx, scope, destination.join(" ")) : await clear(ctx, scope);
    if (!result) ctx.ui.notify("已取消清理，未删除文件。", "info");
    else if (!result.ok) ctx.ui.notify(result.message, "error");
    else ctx.ui.notify(action === "export" ? `已导出脱敏诊断：${"path" in result.value ? result.value.path : ""}；${result.value.count} 条记录，未上传。` : `已清理${labels[scope]}的 ${result.value.count} 个诊断文件；后续记录不受影响。`, "info");
  }
  return { command: async (args: string, ctx: ExtensionCommandContext) => {
    try { await command(args, ctx); }
    catch (error) { const result = failure(error); if (!result.ok) ctx.ui.notify(result.message, "error"); }
  }, status, exportFile, clear };
}
