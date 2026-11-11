import { isRecord } from "../src/value-guards.ts";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureDiagnosticScope, diagnosticDirectory, diagnosticErrorCode, matchesDiagnosticScope, readDiagnosticText, withDiagnosticLock, type DiagnosticScope, type DiagnosticResumeResult } from "./diagnostic-storage.ts";
import { isGlobalDiagnosticEvent } from "./global-diagnostics.ts";
import { showMenu, isMenuBack, MENU_BACK } from "./ui.ts";

type Scope = DiagnosticScope;
type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const names = (scope: Scope) => scope === "handoff" ? ["handoff.jsonl.1", "handoff.jsonl"] : ["runtime.jsonl.1", "runtime.jsonl"];
const labels = { project: "当前项目", global: "本机全局（所有项目）", handoff: "当前项目详细交接日志" };
const validScope = (scope: string | undefined): scope is Scope => scope === "project" || scope === "global" || scope === "handoff";
const categories = new Set(["initialization", "command", "role-switch", "workflow-control", "runtime-recovery", "workflow-rejection", "outcome-unknown", "delivery", "business-rejection", "tool-failure", "provider-http", "assistant-failure", "compaction-failure", "suspected-loop", "suspected-slow", "context-budget", "runtime-failure", "delivery-failure", "suspected-stall"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function safeRecord(line: string): Result<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { return { ok: false, code: "INVALID_DIAGNOSTIC_JSON", message: "诊断记录损坏或未写完整，请稍后重试。" }; }
  if (!isRecord(value)) return { ok: false, code: "INVALID_DIAGNOSTIC_RECORD", message: "诊断记录不是对象，未导出。" };
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
  resume: (ctx: ExtensionCommandContext, scope: Scope) => Promise<DiagnosticResumeResult>;
  agentDir?: () => string;
}) {
  function location(ctx: ExtensionCommandContext, scope: Scope) {
    const root = scope === "global" ? (deps.agentDir ?? getAgentDir)() : ctx.cwd;
    const parts = scope === "global" ? ["diagnostics", "pi-init"] : [".pi", scope === "handoff" ? "logs" : "diagnostics"];
    return { root, parts, path: join(root, ...parts, scope === "handoff" ? "handoff.jsonl" : "runtime.jsonl") };
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
    if (!validScope(scope)) return { ok: false, code: "INVALID_SCOPE", message: "请选择项目、全局或详细交接日志范围。" };
    if (!ctx.isProjectTrusted()) return { ok: false, code: "UNTRUSTED", message: "未信任项目，不能操作诊断文件。" };
    const initial = captureDiagnosticScope(ctx);
    try {
      await deps.flush();
      if (!matchesDiagnosticScope(ctx, initial)) return { ok: false, code: "DIAGNOSTIC_SCOPE_CHANGED", message: "项目、会话或分支已变化，未操作诊断文件。" };
      const { root, parts } = location(ctx, scope);
      const directory = await diagnosticDirectory(root, parts);
      return {
        ok: true, value: await withDiagnosticLock(directory, async () => {
          if (!matchesDiagnosticScope(ctx, initial) || await diagnosticDirectory(root, parts) !== directory) {
            throw Object.assign(new Error("诊断操作范围已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
          }
          return action(directory);
        })
      };
    } catch (error) { return failure(error); }
  }
  async function regularFiles(directory: string, scope: Scope) {
    const files: string[] = [];
    for (const name of names(scope)) {
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
      for (const file of await regularFiles(directory, scope)) {
        const text = await readDiagnosticText(file, 2 * 1024 * 1024);
        for (const line of text.split("\n").filter(Boolean)) {
          const record = safeRecord(line);
          if (!record.ok) throw Object.assign(new Error(record.message), { code: record.code });
          records.push(record.value);
          if (records.length > 256) records.shift();
        }
      }
      if (!records.length) throw Object.assign(new Error("没有可导出的诊断"), { code: "NO_DIAGNOSTIC_DATA" });
      const path = resolve(ctx.cwd, target);
      const parent = await fs.realpath(dirname(path));
      for (const range of ["project", "global", "handoff"] as const) {
        const resource = location(ctx, range);
        let resourceDirectory: string;
        try { resourceDirectory = await fs.realpath(dirname(resource.path)); }
        catch (error) { if (diagnosticErrorCode(error) === "ENOENT") continue; throw error; }
        if (parent === resourceDirectory && [...names(range), "runtime.lock"].includes(basename(path))) throw Object.assign(new Error("不能导出到诊断存储文件"), { code: "RESERVED_DIAGNOSTIC_TARGET" });
      }
      await fs.writeFile(path, JSON.stringify({ version: 1, scope, limit: 256, records }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return { path, count: records.length };
    });
  }
  async function clear(ctx: ExtensionCommandContext, scope: Scope): Promise<Result<{ count: number }> | undefined> {
    if (!validScope(scope)) return { ok: false, code: "INVALID_SCOPE", message: "请选择项目、全局或详细交接日志范围。" };
    if (!ctx.isProjectTrusted() || !ctx.hasUI) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "清理需要受信任项目和交互式确认，未删除文件。" };
    const initial = captureDiagnosticScope(ctx);
    if (!await ctx.ui.confirm(`清理${labels[scope]}诊断？`, `目标：${location(ctx, scope).path} 及 .1 备份。删除后不可恢复，不影响工作流状态和会话文件；不会自动恢复已停录的记录器，可另行使用 /blackbox resume ${scope}。是否确认？`)) return undefined;
    if (!matchesDiagnosticScope(ctx, initial)) return { ok: false, code: "DIAGNOSTIC_SCOPE_CHANGED", message: "确认期间项目、会话或分支已变化，未删除文件。" };
    return operate(ctx, scope, async directory => {
      const files = await regularFiles(directory, scope);
      for (const file of files) await fs.unlink(file);
      return { count: files.length };
    });
  }
  async function status(ctx: ExtensionCommandContext) {
    const lines = [await deps.report(ctx)];
    if (!ctx.isProjectTrusted()) return lines.join("\n");
    for (const scope of ["project", "global", "handoff"] as const) {
      const result = await operate(ctx, scope, async directory => {
        const files = await regularFiles(directory, scope);
        for (const file of files) {
          const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          await handle.close();
        }
        return files.length;
      });
      lines.push(`${labels[scope]}：${location(ctx, scope).path}（及 .1 备份）；${result.ok ? `可访问，${result.value} 个日志文件` : `不可访问或尚未生成：${result.code}`}。`);
    }
    lines.push("状态仅代表本次检查，不是跨进程健康证明。全局仅记录 pi-init 自身可观测故障，不覆盖加载前或宿主未暴露故障。导出不含正文、快照、消息、配置或工具内容；最多最近 256 条，关联标识再次哈希。详细日志导出同样仅含上述有限元数据。不会上传；清理后仍可能有新记录。停录后可显式 resume，仅接收后续新事件，不重放、不改变记录模式。遗留 runtime.lock 不会自动移除。");
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
        { value: "resume", label: "恢复诊断记录", description: "检查存储和锁，仅接收后续新事件，不重放任务" },
        { value: MENU_BACK, label: "← 返回" },
      ]);
      if (!selected || isMenuBack(selected)) return;
      if (selected === "status") return command("status", ctx);
      const range = await showMenu(ctx, "选择诊断范围", [
        { value: "project", label: labels.project }, { value: "global", label: labels.global }, { value: "handoff", label: labels.handoff }, { value: MENU_BACK, label: "← 取消" },
      ]);
      if (!range || isMenuBack(range)) { ctx.ui.notify("已取消，未导出或清理文件。", "info"); return; }
      const target = selected === "export" ? await ctx.ui.input("导出到新文件", "输入目标路径，不覆盖已有文件") : "";
      if (selected === "export" && !target?.trim()) { ctx.ui.notify("已取消，未导出文件。", "info"); return; }
      return command(`${selected} ${range} ${target}`, ctx);
    }
    if (!["export", "clear", "resume"].includes(action) || !validScope(scope) || action !== "export" && destination.length) {
      ctx.ui.notify("用法：/blackbox [status|menu|export <project|global|handoff> <新文件路径>|clear <project|global|handoff>|resume <project|global|handoff>]；清理必须交互确认，恢复仅启用后续诊断。", "warning"); return;
    }
    if (action === "resume") {
      const result = await resume(ctx, scope);
      ctx.ui.notify(result.ok ? `${labels[scope]}诊断记录已启用，仅接收后续新事件；未重放日志或任务。` : `恢复失败（${result.code}${result.causeCode ? " / " + result.causeCode : ""}）：${result.message}`, result.ok ? "info" : "error");
      return;
    }
    const result = action === "export" ? await exportFile(ctx, scope, destination.join(" ")) : await clear(ctx, scope);
    if (!result) ctx.ui.notify("已取消清理，未删除文件。", "info");
    else if (!result.ok) ctx.ui.notify(result.message, "error");
    else ctx.ui.notify(action === "export" ? `已导出脱敏诊断：${"path" in result.value ? result.value.path : ""}；${result.value.count} 条记录，未上传。` : `已清理${labels[scope]}的 ${result.value.count} 个诊断文件；未改变记录器启停状态。`, "info");
  }
  async function resume(ctx: ExtensionCommandContext, scope: Scope): Promise<DiagnosticResumeResult> {
    if (!validScope(scope)) return { ok: false, code: "INVALID_SCOPE", message: "请选择项目、全局或详细交接日志范围。" };
    if (!ctx.isProjectTrusted()) return { ok: false, code: "UNTRUSTED", message: "未信任项目，不能恢复诊断记录。" };
    return deps.resume(ctx, scope);
  }
  return { command: async (args: string, ctx: ExtensionCommandContext) => {
    try { await command(args, ctx); }
    catch (error) { const result = failure(error); if (!result.ok) ctx.ui.notify(result.message, "error"); }
  }, status, exportFile, clear, resume
  };
}
