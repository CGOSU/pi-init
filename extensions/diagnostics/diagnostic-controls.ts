import { isRecord } from "../../src/value-guards.ts";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { captureDiagnosticScope, diagnosticErrorCode, matchesDiagnosticScope, readDiagnosticText, type DiagnosticScope, type DiagnosticResumeResult } from "./diagnostic-storage.ts";
import {
  clearManagedSidecars, DIAGNOSTIC_BASE, diagnosticKeys, diagnosticLocation, DIAGNOSTIC_MAX_BYTES,
  findDiagnosticFiles, isDiagnosticSessionKey, recentDiagnosticFiles, removeEmptyDiagnosticProject,
  withDiagnosticLocation, type DiagnosticFile,
} from "./diagnostic-layout.ts";
import { isGlobalDiagnosticEvent } from "./global-diagnostics.ts";
import { showMenu, isMenuBack, MENU_BACK } from "../ui.ts";

type Scope = DiagnosticScope;
type ClearScope = Scope | "expired" | "sidecars";
type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
function inside(directory: string, file: string) {
  const child = relative(directory, file);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}
const scopeChanged = () => Object.assign(new Error("诊断操作范围已变化"), { code: "DIAGNOSTIC_SCOPE_CHANGED" });
const labels = { project: "当前项目", global: "本机全局（所有项目）", handoff: "当前项目详细交接日志" };
const validScope = (scope: string | undefined): scope is Scope => scope === "project" || scope === "global" || scope === "handoff";
const invalidScope = { ok: false, code: "INVALID_SCOPE", message: "请选择项目、全局或详细交接日志范围。" } as const;
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
  report: (ctx: ExtensionCommandContext, sessionKey?: string) => Promise<string>;
  flush: () => Promise<unknown>;
  resume: (ctx: ExtensionCommandContext, scope: Scope) => Promise<DiagnosticResumeResult>;
  agentDir?: () => string;
}) {
  const agentDir = deps.agentDir ?? getAgentDir;
  const currentKey = (ctx: ExtensionCommandContext) => diagnosticKeys(ctx.cwd, ctx.sessionManager.getSessionId()).sessionKey;
  const locate = (ctx: ExtensionCommandContext, scope: Scope, sessionKey?: string) => diagnosticLocation(agentDir(), scope, ctx.cwd, sessionKey);

  function failure(error: unknown): { ok: false; code: string; message: string } {
    const code = diagnosticErrorCode(error);
    const reasons: Record<string, string> = {
      RESERVED_DIAGNOSTIC_TARGET: "不能导出到受管诊断目录或旧日志路径。",
      EEXIST: "目标已经存在，不覆盖已有文件。", ENOENT: "目录或文件不存在，可能尚未产生诊断。",
      EACCES: "没有文件访问权限。", EPERM: "系统拒绝文件操作。", ENOSPC: "磁盘空间不足。",
      DIAGNOSTIC_SCOPE_CHANGED: "项目、会话、分支或存储位置已变化。",
      DIAGNOSTIC_LOCK_BUSY: "诊断正被使用或存在遗留锁，请核对后重试。",
      DIAGNOSTIC_QUOTA_EXCEEDED: "侧车达到留存或扫描上限，请显式清理不再需要的诊断。",
      UNSAFE_DIAGNOSTIC_PATH: "目录或文件不是普通路径，拒绝跟随链接。",
      DIAGNOSTIC_TOO_LARGE: "最近诊断文件超过单文件 2 MiB 读取上限。",
      NO_DIAGNOSTIC_DATA: "没有可导出的诊断记录。",
      INVALID_DIAGNOSTIC_JSON: "诊断记录损坏或未写完整。",
      INVALID_DIAGNOSTIC_RECORD: "诊断记录不是对象。",
      INVALID_DIAGNOSTIC_SESSION: "请输入当前项目中的 64 位诊断会话键。",
    };
    return { ok: false, code, message: `诊断操作失败（${code}）：${reasons[code] ?? "请检查文件权限、目录及活动锁。"} 清理若中途失败，已删除的文件不会恢复；导出写入若失败，目标可能含不完整内容。` };
  }
  async function withStore<T>(ctx: ExtensionCommandContext, location: ReturnType<typeof locate>,
    action: (root: string, current: () => boolean) => Promise<T>): Promise<Result<T>> {
    if (!ctx.isProjectTrusted()) return { ok: false, code: "UNTRUSTED", message: "未信任项目，不能操作诊断文件。" };
    const initial = captureDiagnosticScope(ctx);
    const current = () => matchesDiagnosticScope(ctx, initial) && resolve(agentDir()) === location.root;
    try {
      await deps.flush();
      if (!current()) throw scopeChanged();
      return {
        ok: true, value: await withDiagnosticLocation(location, { current }, root => action(root, current)),
      };
    } catch (error) { return failure(error); }
  }

  async function operate<T>(ctx: ExtensionCommandContext, location: ReturnType<typeof locate>,
    action: (files: DiagnosticFile[], root: string, current: () => boolean) => Promise<T>): Promise<Result<T>> {
    return withStore(ctx, location, async (root, current) => {
      const files = await findDiagnosticFiles(location, root);
      if (!current()) throw scopeChanged();
      return action(files, root, current);
    });
  }

  async function exportFile(ctx: ExtensionCommandContext, scope: Scope, target: string, sessionKey?: string): Promise<Result<{ path: string; count: number; limited: boolean }>> {
    if (!validScope(scope)) return invalidScope;
    if (!target.trim()) return { ok: false, code: "MISSING_TARGET", message: "请提供导出目标文件路径。" };
    const path = resolve(ctx.cwd, target);
    const cwd = resolve(ctx.cwd);
    let location: ReturnType<typeof locate>;
    try { location = locate(ctx, scope, sessionKey); }
    catch (error) { return failure(error); }
    return operate(ctx, location, async (files, root, current) => {
      const recent = recentDiagnosticFiles(files, DIAGNOSTIC_MAX_BYTES);
      if (!recent.files.length && recent.limited) throw Object.assign(new Error("诊断文件过大"), { code: "DIAGNOSTIC_TOO_LARGE" });
      let limited = recent.limited;
      const records: Record<string, unknown>[] = [];
      for (const file of recent.files) {
        for (const line of (await readDiagnosticText(file.path, DIAGNOSTIC_MAX_BYTES)).split("\n").filter(Boolean)) {
          const record = safeRecord(line);
          if (!record.ok) throw Object.assign(new Error(record.message), { code: record.code });
          records.push(record.value);
          if (records.length > 256) { records.shift(); limited = true; }
        }
      }
      if (!records.length) throw Object.assign(new Error("没有可导出的诊断"), { code: "NO_DIAGNOSTIC_DATA" });
      const parent = await fs.realpath(dirname(path));
      const output = join(parent, basename(path));
      const canonicalCwd = await fs.realpath(cwd);
      if (inside(root, output) || inside(join(cwd, ".pi"), path) || inside(join(canonicalCwd, ".pi"), output)) {
        throw Object.assign(new Error("不能导出到受管路径"), { code: "RESERVED_DIAGNOSTIC_TARGET" });
      }
      if (!current()) throw scopeChanged();
      await fs.writeFile(output, JSON.stringify({ version: 1, scope, ...(sessionKey ? { selection: "session" } : {}), limit: 256, limited, records }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return { path, count: records.length, limited };
    });
  }

  async function clearSidecars(ctx: ExtensionCommandContext, mode: "expired" | "sidecars"): Promise<Result<{ count: number }> | undefined> {
    if (!ctx.isProjectTrusted() || !ctx.hasUI) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "清理需要受信任项目和交互式确认，未删除文件。" };
    const initial = captureDiagnosticScope(ctx);
    let location: ReturnType<typeof locate>;
    try { location = locate(ctx, "project"); }
    catch (error) { return failure(error); }
    const baseRoot = join(location.root, ...DIAGNOSTIC_BASE);
    const description = mode === "expired"
      ? `目标：${baseRoot} 下所有项目超过 7 天的已过期会话黑匣子与详细交接日志（.jsonl / .jsonl.1）。删除后不可恢复；不清理 Pi 会话、本机全局摘要或旧项目日志。`
      : `目标：${baseRoot} 下所有项目的全部会话黑匣子与详细交接日志（释放全部 128 组全局名额）。删除后不可恢复；不清理 Pi 会话、本机全局摘要或旧项目日志。不会自动恢复停录，请另行使用 /blackbox resume project。`;
    if (!await ctx.ui.confirm(mode === "expired" ? "清理所有项目已过期诊断？" : "清理所有项目全部会话诊断？", description)) return undefined;
    try {
      if (!matchesDiagnosticScope(ctx, initial) || locate(ctx, "project").root !== location.root) return failure(scopeChanged());
    } catch (error) { return failure(error); }
    return withStore(ctx, location, async (root, current) => ({
      count: await clearManagedSidecars(root, { expiredOnly: mode === "expired", current }),
    }));
  }

  async function clear(ctx: ExtensionCommandContext, scope: ClearScope, sessionKey?: string): Promise<Result<{ count: number }> | undefined> {
    if (scope === "expired" || scope === "sidecars") {
      if (sessionKey !== undefined) return { ok: false, code: "INVALID_SCOPE", message: "跨项目清理不支持指定会话键。" };
      return clearSidecars(ctx, scope);
    }
    if (!validScope(scope)) return invalidScope;
    if (!ctx.isProjectTrusted() || !ctx.hasUI) return { ok: false, code: "CONFIRMATION_REQUIRED", message: "清理需要受信任项目和交互式确认，未删除文件。" };
    const initial = captureDiagnosticScope(ctx);
    let location: ReturnType<typeof locate>;
    try { location = locate(ctx, scope, sessionKey); }
    catch (error) { return failure(error); }
    const label = labels[scope] + (sessionKey ? "（选定会话）" : "");
    const detail = location.name ? "及其 .1 备份" : "内的受管会话 .jsonl 和 .jsonl.1 文件";
    if (!await ctx.ui.confirm(`清理${label}诊断？`, `目标：${location.path} ${detail}。删除后不可恢复；不清理 Pi 会话、旧项目日志或工作流。不会自动恢复停录，请另行使用 /blackbox resume ${scope}。`)) return undefined;
    try {
      if (!matchesDiagnosticScope(ctx, initial) || locate(ctx, scope, sessionKey).path !== location.path) return failure(scopeChanged());
    } catch (error) { return failure(error); }
    return operate(ctx, location, async (files, root, current) => {
      for (const file of files) {
        if (!current()) throw scopeChanged();
        await fs.unlink(file.path);
      }
      await removeEmptyDiagnosticProject(location, root);
      return { count: files.length };
    });
  }

  async function status(ctx: ExtensionCommandContext, sessionKey?: string) {
    if (sessionKey !== undefined && !isDiagnosticSessionKey(sessionKey)) {
      return failure(Object.assign(new Error("会话标识不是诊断会话键"), { code: "INVALID_DIAGNOSTIC_SESSION" })).message;
    }
    const initial = captureDiagnosticScope(ctx);
    const lines = [await deps.report(ctx, sessionKey)];
    if (!ctx.isProjectTrusted()) return lines.join("\n");
    for (const scope of ["project", "global", "handoff"] as const) {
      if (!matchesDiagnosticScope(ctx, initial)) throw scopeChanged();
      const location = locate(ctx, scope, scope === "global" ? undefined : sessionKey);
      const result = await operate(ctx, location, async files => {
        for (const file of files) await fs.access(file.path, constants.R_OK);
        return files.length;
      });
      const description = !result.ok && result.code !== "ENOENT" ? `检查失败（${result.code}）`
        : result.ok && result.value ? `发现 ${result.value} 个可读日志文件` : "尚无诊断文件";
      lines.push(`${labels[scope]}：${location.path}（${location.name ? "及 .1 备份" : "各会话及 .1 备份"}）；${description}。`);
    }
    lines.push("状态仅代表本次检查，不是跨进程健康证明。全局仅含 pi-init 自身可观测故障。导出为有限脱敏样本（最多 256 条），不含正文、快照、配置或工具内容，不上传。清理后仍可能有新记录；resume 仅探测当前会话并接收后续新事件，不重放、不改变记录模式。遗留 runtime.lock 或 sidecar.lock 不会自动移除。");
    return lines.join("\n");
  }

  async function chooseSession(ctx: ExtensionCommandContext) {
    const items = new Map<string, number>([[currentKey(ctx), 0]]);
    for (const scope of ["project", "handoff"] as const) {
      const result = await operate(ctx, locate(ctx, scope), async files => files);
      if (!result.ok && result.code !== "ENOENT") { ctx.ui.notify(result.message, "error"); return; }
      if (result.ok) for (const { sessionKey, mtimeMs } of result.value) {
        if (sessionKey) items.set(sessionKey, Math.max(items.get(sessionKey) ?? 0, mtimeMs));
      }
    }
    return showMenu(ctx, "选择要查看的诊断会话", [
      ...[...items].sort((a, b) => b[1] - a[1]).map(([key, mtime]) => ({
        value: key, label: (key === currentKey(ctx) ? "当前会话 " : "") + key.slice(0, 16),
        description: mtime ? new Date(mtime).toISOString() : "尚无记录",
      })),
      { value: MENU_BACK, label: "← 返回" },
    ]);
  }

  async function menu(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI || !ctx.isProjectTrusted()) { ctx.ui.notify("诊断面板需要受信任项目和交互式界面；可使用 /blackbox status。", "warning"); return; }
    const initial = captureDiagnosticScope(ctx);
    const root = resolve(agentDir());
    const current = () => matchesDiagnosticScope(ctx, initial) && resolve(agentDir()) === root;
    const selected = await showMenu(ctx, "运行诊断", [
      { value: "status", label: "查看项目与全局状态" },
      { value: "session", label: "查看指定会话" },
      { value: "export", label: "导出有限脱敏诊断", description: "仅本机写入新文件，不上传，不覆盖已有文件" },
      { value: "clear", label: "清理诊断日志", description: "选择范围后再次确认；不清理工作流或 Pi 会话" },
      { value: "resume", label: "恢复诊断记录", description: "仅探测目标并接收后续新事件，不重放任务" },
      { value: MENU_BACK, label: "← 返回" },
    ]);
    if (!selected || isMenuBack(selected)) return;
    if (!current()) throw scopeChanged();
    if (selected === "status") return command("status", ctx);
    if (selected === "session") {
      const key = await chooseSession(ctx);
      if (!current()) throw scopeChanged();
      if (key && !isMenuBack(key)) await command(`status session ${key}`, ctx);
      return;
    }
    const range = await showMenu(ctx, "选择诊断范围", [
      { value: "project", label: labels.project + (selected === "resume" ? "（探测当前会话）" : "（所有会话）") },
      { value: "global", label: labels.global },
      { value: "handoff", label: labels.handoff + (selected === "resume" ? "（探测当前会话）" : "（所有会话）") },
      ...(selected === "resume" ? [] : [
        { value: "session", label: "选定会话黑匣子" },
        { value: "handoff-session", label: "选定会话详细交接日志" },
      ]),
      ...(selected === "clear" ? [
        { value: "expired", label: "所有项目已过期诊断（7 天前）" },
        { value: "sidecars", label: "所有项目全部会话诊断（释放全局名额）" },
      ] : []),
      { value: MENU_BACK, label: "← 取消" },
    ]);
    if (!range || isMenuBack(range)) return;
    if (!current()) throw scopeChanged();
    if (range === "session" || range === "handoff-session") {
      const key = await chooseSession(ctx);
      if (!key || isMenuBack(key)) return;
      if (!current()) throw scopeChanged();
      const scope = range === "session" ? "project" : "handoff";
      const target = selected === "export" ? await ctx.ui.input("导出到新文件", "输入目标路径，不覆盖已有文件") : undefined;
      if (!current()) throw scopeChanged();
      if (selected === "clear") notifyResult(ctx, await clear(ctx, scope, key));
      else if (target?.trim()) notifyResult(ctx, await exportFile(ctx, scope, target, key));
      return;
    }
    const target = selected === "export" ? await ctx.ui.input("导出到新文件", "输入目标路径，不覆盖已有文件") : "";
    if (!current()) throw scopeChanged();
    if (selected === "export" && !target?.trim()) { ctx.ui.notify("已取消，未导出文件。", "info"); return; }
    await command(`${selected} ${range} ${target}`, ctx);
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [action = "status", range, ...destination] = args.trim().split(/\s+/).filter(Boolean);
    if (action === "status" && !range) { ctx.ui.notify(await status(ctx), "info"); return; }
    if (action === "status" && range === "session" && destination.length <= 1) {
      const key = destination[0] ?? currentKey(ctx);
      if (!isDiagnosticSessionKey(key)) { ctx.ui.notify("请输入 64 位诊断会话键。", "warning"); return; }
      ctx.ui.notify(await status(ctx, key), "info");
      return;
    }
    if (action === "menu" && !range) return menu(ctx);
    if (action === "clear" && (range === "expired" || range === "sidecars") && !destination.length) {
      notifyResult(ctx, await clear(ctx, range));
      return;
    }
    const scope = range === "session" ? "project" : range === "handoff-session" ? "handoff" : range;
    if (!validScope(scope) || !["export", "clear", "resume"].includes(action) || (action !== "export" && destination.length) || (action === "resume" && scope !== range)) {
      ctx.ui.notify("用法：/blackbox [status [session [会话键]]|menu|export <范围> <新文件>|clear <范围|expired|sidecars>|resume <project|global|handoff>]；查看/导出/清理的会话范围可选 session 或 handoff-session（命令中的操作范围为当前会话）。", "warning");
      return;
    }
    const sessionKey = scope !== range ? currentKey(ctx) : undefined;
    if (action === "resume") {
      const result = await resume(ctx, scope);
      if (!result.ok) {
        ctx.ui.notify(`恢复失败（${result.code}${result.causeCode ? " / " + result.causeCode : ""}）：${result.message}`, "error");
      } else {
        const location = locate(ctx, scope, scope === "global" ? undefined : currentKey(ctx));
        ctx.ui.notify(`诊断记录已启用：${location.path}；仅接收后续新事件，未重放日志或任务。`, "info");
      }
      return;
    }
    notifyResult(ctx, action === "export" ? await exportFile(ctx, scope, destination.join(" "), sessionKey) : await clear(ctx, scope, sessionKey));
  }

  function notifyResult(ctx: ExtensionCommandContext, result: Awaited<ReturnType<typeof exportFile> | ReturnType<typeof clear>>) {
    if (!result) ctx.ui.notify("已取消清理，未删除文件。", "info");
    else if (!result.ok) ctx.ui.notify(result.message, "error");
    else if ("path" in result.value && "limited" in result.value) ctx.ui.notify(`已导出脱敏诊断：${result.value.path}；${result.value.count} 条${result.value.limited ? "（已按上限截取）" : ""}，未上传。`, "info");
    else ctx.ui.notify(`已清理 ${result.value.count} 个已确认范围内的诊断文件；未改变记录器启停状态。`, "info");
  }

  async function resume(ctx: ExtensionCommandContext, scope: Scope): Promise<DiagnosticResumeResult> {
    if (!validScope(scope)) return invalidScope;
    if (!ctx.isProjectTrusted()) return { ok: false, code: "UNTRUSTED", message: "未信任项目，不能恢复诊断记录。" };
    return deps.resume(ctx, scope);
  }
  return { command: async (args: string, ctx: ExtensionCommandContext) => {
    try { await command(args, ctx); }
    catch (error) { const result = failure(error); if (!result.ok) ctx.ui.notify(result.message, "error"); }
  }, status, exportFile, clear, resume };
}
