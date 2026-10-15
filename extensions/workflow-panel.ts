import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowStatusPanelSummary, formatWorkflowStatusText, workflowStatusTaskItems } from "./workflow-status-renderer.ts";
import { workflowPanelChoices, type WorkflowPanelRequest } from "./workflow-panel-actions.ts";

export async function showWorkflowPanel(ctx: ExtensionCommandContext, state: ExtensionRuntimeState): Promise<WorkflowPanelRequest | undefined> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await ctx.ui.custom<WorkflowPanelRequest | undefined>((tui, theme, _bindings, done) => {
      let page: "tasks" | "detail" | "actions" | "technical" = "tasks";
      let actionOrigin: "tasks" | "detail" = "tasks";
      let technicalOrigin: "tasks" | "detail" | "actions" = "tasks";
      let scroll = 0;
      let detailId: string | undefined;
      let notice = "";
      let workflowId = state.workflowState?.workflowId;
      let capacity = 5;
      let itemsKey = "";
      const listTheme = { selectedPrefix: (text: string) => theme.bg("selectedBg", theme.fg("accent", text)), selectedText: (text: string) => theme.bg("selectedBg", theme.fg("text", text)), description: (text: string) => theme.fg("muted", text), scrollInfo: (text: string) => theme.fg("dim", text), noMatch: (text: string) => theme.fg("warning", text) };
      let list: SelectList;
      const refresh = () => {
        const changed = workflowId !== state.workflowState?.workflowId;
        if (changed) { workflowId = state.workflowState?.workflowId; page = "tasks"; detailId = undefined; scroll = 0; notice = "流程已切换，已定位当前任务。"; }
        if (page === "detail" && !state.workflowState?.tasks.some((task) => task.id === detailId)) { page = "tasks"; scroll = 0; }
        const view = createCurrentWorkflowStatusView(state);
        const choices = workflowPanelChoices(state);
        const items: SelectItem[] = page === "actions" ? choices.map((choice) => ({ value: choice.value, label: (choice.disabledReason ? "不可用 · " : "") + choice.label, description: choice.disabledReason ?? choice.description })) : workflowStatusTaskItems(view);
        if (!items.length) items.push({ value: "none", label: "当前没有可执行操作", description: "可按 Esc 返回或 d 查看技术详情" });
        const key = JSON.stringify([page === "actions", capacity, items]);
        if (changed || key !== itemsKey) {
          const selected = changed ? undefined : list?.getSelectedItem()?.value;
          list = new SelectList(items, Math.min(capacity, items.length), listTheme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 });
          const target = selected && items.some((item) => item.value === selected) ? selected : view.kind === "workflow" ? view.progress.currentTaskId : undefined;
          list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === target)));
          list.onCancel = () => { if (page === "tasks") done(undefined); else { page = "tasks"; scroll = 0; } };
          list.onSelect = (item) => {
            if (page === "actions") {
              const choice = workflowPanelChoices(state).find((entry) => entry.value === item.value);
              if (!choice || choice.disabledReason) { notice = choice?.disabledReason ?? "当前没有可执行操作"; return; }
              if (!ctx.isProjectTrusted()) { notice = "项目尚未受信任，未执行操作"; return; }
              if (state.workflowState) done({ choice, workflow: state.workflowState, contextGeneration: state.roleContextGeneration, sessionId: ctx.sessionManager.getSessionId() });
            } else { detailId = item.value; page = "detail"; scroll = 0; }
          };
          itemsKey = key;
        }
        return view;
      };
      const detailText = () => {
        const task = state.workflowState?.tasks.find((item) => item.id === detailId);
        if (!task) return "当前没有任务详情。";
        return ["任务：" + task.task, "状态：" + ({ pending: "待处理", in_progress: "进行中", completed: "已完成", blocked: "已阻塞", superseded: "已替换" }[task.status]), "角色：" + task.role, "范围：" + task.files.join("、"), "验收标准：", ...task.acceptanceCriteria.map((item) => "- " + item), task.blockReason ? "阻塞原因：" + task.blockReason : "", task.outcomeUnknown ? "结果未知：先核对副作用，不可直接重试。" : "", task.completionSummary ? "完成结果：" + task.completionSummary : "", task.implementationRationale ? "实现原因：" + task.implementationRationale : "", "实际验证：", ...(task.verification?.length ? task.verification : ["尚未记录实际验证"] )].filter(Boolean).join("\n");
      };
      let pageSize = 8;
      refresh();
      timer = setInterval(() => { if (state.runtimeDisposed) { done(undefined); if (timer) clearInterval(timer); return; } tui.requestRender(); }, 1000);
      timer.unref?.();
      return {
        render(width: number) {
          const view = refresh();
          const inner = Math.max(1, width - 2);
          const height = Math.max(4, Math.min(28, (tui.terminal?.rows ?? 30) - 4));
          const footer = page === "tasks" ? (width < 55 ? width < 32 ? ["Esc关闭 · Enter详情", "↑↓浏览 · a操作 · d技术"] : ["↑↓ · Enter 详情 · Esc 关闭", "a 操作 · d 技术详情"] : ["↑↓ 浏览 · Enter 详情 · a 操作 · d 技术 · Esc 关闭"]) : page === "actions" ? [width < 32 ? "Esc返回 · ↑↓ · Enter" : "↑↓ · Enter 选择 · Esc 返回"] : [width < 32 ? "Esc返回 · ↑↓滚动" : width < 55 ? "↑↓ 滚动 · Esc 返回" : "↑↓ / PgUp / PgDn 滚动 · Esc 返回"];
          const totalBudget = Math.max(1, height - footer.length - 2);
          const budget = Math.max(1, totalBudget - (notice ? 1 : 0));
          let body: string[];
          if (page === "detail" || page === "technical") {
            const lines = new Text(page === "detail" ? detailText() : formatWorkflowStatusText(view), 0, 0).render(inner);
            pageSize = Math.max(1, budget - 1);
            scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - pageSize)));
            body = [theme.fg("accent", theme.bold(page === "detail" ? "任务详情" : "技术详情（只读）")), ...lines.slice(scroll, scroll + Math.max(1, budget - 1))];
          } else {
            const summary = new Text(page === "actions" ? "选择操作；不可用项会说明原因。\n" + formatWorkflowStatusPanelSummary(view) : formatWorkflowStatusPanelSummary(view), 0, 0).render(inner).slice(0, Math.max(1, Math.min(6, budget - 4)));
            capacity = Math.max(1, Math.min(5, Math.floor((budget - summary.length - 1) / 2)));
            refresh();
            body = [...summary, theme.fg("accent", page === "actions" ? "当前可用操作" : "任务列表"), ...list.render(inner)];
          }
          body = body.slice(0, budget);
          if (notice) body.push(theme.fg("warning", truncateToWidth(notice, inner)));
          const lines = [...body.slice(0, totalBudget), ...footer.map((line) => theme.fg("muted", line))];
          const framed = lines.map((line) => { const text = truncateToWidth(line, inner); return "│" + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + "│"; });
          return ["┌" + "─".repeat(inner) + "┐", ...framed, "└" + "─".repeat(inner) + "┘"].map((line) => truncateToWidth(line, Math.max(1, width)));
        },
        invalidate() { list.invalidate(); },
        handleInput(data: string) {
          refresh();
          if (matchesKey(data, Key.escape)) {
            if (page === "technical") page = technicalOrigin;
            else if (page === "actions") page = actionOrigin;
            else if (page !== "tasks") page = "tasks";
            else done(undefined);
            scroll = 0;
          } else if (data === "a" && (page === "tasks" || page === "detail")) { actionOrigin = page; page = "actions"; scroll = 0; notice = ""; }
          else if (data === "d" && page !== "technical") { technicalOrigin = page; page = "technical"; scroll = 0; }
          else if (page === "detail" || page === "technical") {
            if (matchesKey(data, Key.up)) scroll = Math.max(0, scroll - 1);
            else if (matchesKey(data, Key.down)) scroll += 1;
            else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - pageSize);
            else if (matchesKey(data, Key.pageDown)) scroll += pageSize;
          } else list.handleInput(data);
          tui.requestRender();
        },
        handleMouse(event: Parameters<SelectList["handleMouse"]>[0]) { refresh(); if (page === "tasks" || page === "actions") { const result = list.handleMouse(event); tui.requestRender(); return result; } return undefined; },
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "95%", margin: 1 } });
  } finally { if (timer) clearInterval(timer); }
}
