import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Key, matchesKey, SelectList, Text, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { createCurrentWorkflowStatusView } from "./workflow-status-view.ts";
import { formatWorkflowStatusText, workflowStatusActivityLabel, workflowStatusTaskItems } from "./workflow-status-renderer.ts";
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
      let selectedTaskId: string | undefined;
      let taskListTop = 0;
      let taskListHeight = 0;
      let listWidth = 80;
      let notice = "";
      let workflowId = state.workflowState?.workflowId;
      let capacity = 5;
      let itemsKey = "";
      const listTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("text", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      };
      let list: SelectList;
      const refresh = () => {
        const changed = workflowId !== state.workflowState?.workflowId;
        if (changed) {
          workflowId = state.workflowState?.workflowId;
          page = "tasks";
          detailId = undefined;
          selectedTaskId = undefined;
          scroll = 0;
          notice = "流程已切换，已定位当前任务。";
        }
        if (page === "detail" && !state.workflowState?.tasks.some((task) => task.id === detailId)) { page = "tasks"; scroll = 0; }
        const view = createCurrentWorkflowStatusView(state);
        const choices = workflowPanelChoices(state);
        const compactList = listWidth < 40;
        const showTaskIds = !compactList && view.kind === "workflow" && Boolean(state.workflowState?.tasks.some((item) => item.dependsOn.length > 0));
        const items: SelectItem[] = page === "actions"
          ? choices.map((choice) => ({ value: choice.value, label: (choice.disabledReason ? "不可用 · " : "› ") + choice.label, description: choice.disabledReason ?? choice.description }))
          : view.kind === "workflow"
            ? view.tasks.map((task, index) => {
                const glyph = task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : task.status === "blocked" ? "!" : task.status === "superseded" ? "↪" : "○";
                const color = task.status === "completed" ? "success" : task.status === "in_progress" ? "accent" : task.status === "blocked" ? "error" : "muted";
                const branch = index === view.tasks.length - 1 ? "└─" : "├─";
                const label = theme.fg(color, compactList
                  ? `${glyph} ${task.task}`
                  : `${branch} ${glyph}${showTaskIds ? ` #${task.id}` : ""}`);
                const activity = task.status === "in_progress" ? ` (${workflowStatusActivityLabel(view.activity)})` : "";
                const subject = task.status === "completed"
                  ? (theme.strikethrough?.(theme.fg("muted", task.task)) ?? theme.fg("muted", task.task))
                  : theme.fg(color === "muted" ? "text" : color, task.task);
                return { value: task.id, label, description: subject + theme.fg("muted", activity) };
              })
            : workflowStatusTaskItems(view);
        if (!items.length) items.push({ value: "none", label: "○", description: "当前没有可执行操作" });
        const key = JSON.stringify([page === "actions", capacity, items]);
        if (changed || key !== itemsKey) {
          const previous = changed ? undefined : page === "tasks" ? selectedTaskId ?? list?.getSelectedItem()?.value : list?.getSelectedItem()?.value;
          list = new SelectList(items, Math.min(capacity, items.length), listTheme, { minPrimaryColumnWidth: 8, maxPrimaryColumnWidth: 24 });
          const target = previous && items.some((item) => item.value === previous)
            ? previous
            : page === "tasks" && view.kind === "workflow" ? view.progress.currentTaskId : undefined;
          list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === target)));
          if (page === "tasks") selectedTaskId = list.getSelectedItem()?.value;
          list.onCancel = () => { if (page === "tasks") done(undefined); else { page = "tasks"; scroll = 0; } };
          list.onSelect = (item) => {
            if (page === "actions") {
              const choice = workflowPanelChoices(state).find((entry) => entry.value === item.value);
              if (!choice || choice.disabledReason) { notice = choice?.disabledReason ?? "当前没有可执行操作"; return; }
              if (!ctx.isProjectTrusted()) { notice = "项目尚未受信任，未执行操作"; return; }
              if (state.workflowState) done({ choice, workflow: state.workflowState, contextGeneration: state.roleContextGeneration, sessionId: ctx.sessionManager.getSessionId() });
            } else {
              selectedTaskId = item.value;
              detailId = item.value;
              page = "detail";
              scroll = 0;
            }
          };
          itemsKey = key;
        }
        return view;
      };
      const detailText = () => {
        const task = state.workflowState?.tasks.find((item) => item.id === detailId);
        if (!task) return "当前没有任务详情。";
        return ["任务 ID：" + task.id, "任务：" + task.task, "状态：" + ({ pending: "待处理", in_progress: "进行中", completed: "已完成", blocked: "已阻塞", superseded: "已替换" }[task.status]), "角色：" + task.role, "范围：" + task.files.join("、"), "验收标准：", ...task.acceptanceCriteria.map((item) => "- " + item), task.blockReason ? "阻塞原因：" + task.blockReason : "", task.outcomeUnknown ? "结果未知：先核对副作用，不可直接重试。" : "", task.completionSummary ? "完成结果：" + task.completionSummary : "", task.implementationRationale ? "实现原因：" + task.implementationRationale : "", "实际验证：", ...(task.verification?.length ? task.verification : ["尚未记录实际验证"] )].filter(Boolean).join("\n");
      };
      let pageSize = 8;
      refresh();
      timer = setInterval(() => { if (state.runtimeDisposed) { done(undefined); if (timer) clearInterval(timer); return; } tui.requestRender(); }, 1000);
      timer.unref?.();
      return {
        render(width: number) {
          listWidth = width;
          const view = refresh();
          const inner = Math.max(1, width - 4);
          const height = Math.max(6, Math.min(28, (tui.terminal?.rows ?? 30) - 4));
          const footer = page === "tasks"
            ? (width < 32 ? ["Esc关闭 · Enter", "↑↓ a操作 d技术"] : width < 55 ? ["↑↓ 浏览 · Enter 查看", "a 操作 · d 技术 · Esc 关闭"] : ["↑↓ 浏览 · Enter 查看 · Esc 关闭", "a 操作 · d 技术详情"])
            : page === "actions"
              ? [width < 32 ? "↑↓选择 · Enter · Esc返回" : "↑↓ 选择 · Enter 执行 · Esc 返回"]
              : [width < 32 ? "↑↓滚动 · Esc返回" : width < 55 ? "↑↓ 滚动 · Esc 返回" : "↑↓ / PgUp / PgDn 滚动 · Esc 返回"];
          const totalBudget = Math.max(1, height - footer.length - 3);
          const budget = Math.max(1, totalBudget - (notice ? 1 : 0));
          const headline = view.kind === "workflow"
            ? theme.fg("accent", theme.bold(listWidth < 40
              ? `${view.status === "running" ? "●" : view.status === "completed" ? "✓" : "⏸"} 工作流 · ${view.status === "running" ? "运行" : view.status === "completed" ? "完成" : "暂停"}`
              : `● 工作流 · ${workflowStatusActivityLabel(view.activity)}`))
            : theme.fg(view.kind === "restore-error" ? "error" : "muted", theme.bold(view.kind === "restore-error" ? "! 工作流恢复失败" : "○ 暂无活动工作流"));
          const headerContent: string[] = [headline];
          if (view.kind === "workflow") {
            const segments = listWidth < 40 ? 4 : 8;
            const filled = view.progress.total > 0 ? Math.round(view.progress.completed / view.progress.total * segments) : 0;
            const progress = theme.fg("accent", "●".repeat(filled)) + theme.fg("dim", "○".repeat(segments - filled));
            headerContent.push(listWidth < 40
              ? `${progress}  ${view.progress.completed}/${view.progress.total}`
              : `${progress}  ${view.progress.completed}/${view.progress.total} 已完成`);
            if (listWidth >= 40) headerContent.push(theme.fg("muted", `› ${view.planSummary}`));
            if (view.activity === "paused") {
              const pauseSummary = view.pause.blockedTasks.length > 0
                ? view.pause.blockedTasks.map((task) => `${task.taskId}：${task.reason}`).join(" · ")
                : view.pause.reason.text;
              headerContent.push(theme.fg("warning", `⏸ ${pauseSummary}`));
            }
          } else if (view.kind === "restore-error") {
            headerContent.push(theme.fg("muted", view.message));
          }
          const header = new Text(headerContent.join("\n"), 0, 0).render(inner);
          let body: string[];
          if (page === "detail" || page === "technical") {
            const lines = new Text(page === "detail" ? detailText() : formatWorkflowStatusText(view), 0, 0).render(inner);
            pageSize = Math.max(1, budget - header.length - 1);
            scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - pageSize)));
            body = [...header, theme.fg("accent", theme.bold(page === "detail" ? "任务详情" : "技术详情 · 只读")), ...lines.slice(scroll, scroll + pageSize)];
          } else {
            body = [...header];
            if (page === "actions" || listWidth >= 40) {
              body.push(theme.fg("accent", theme.bold(page === "actions" ? "当前可用操作" : `任务 · ${view.kind === "workflow" ? view.tasks.length : 0}`)));
            }
            capacity = Math.max(1, Math.min(8, budget - body.length));
            refresh();
            taskListTop = body.length + 1;
            const renderedList = list.render(inner);
            taskListHeight = renderedList.length;
            body.push(...renderedList);
          }
          if (notice) body.push(theme.fg("warning", truncateToWidth(notice, inner)));
          const lines = [
            ...body.slice(0, totalBudget),
            theme.fg("dim", "─".repeat(inner)),
            ...footer.map((line) => theme.fg("muted", line)),
          ].map((line) => truncateToWidth(line, inner));
          const panel = new Box(1, 0, (line) => theme.bg("toolPendingBg", line));
          panel.addChild(new Text(lines.join("\n"), 0, 0));
          const verticalBorder = theme.bg("toolPendingBg", theme.fg("borderAccent", "│"));
          const framedContent = panel.render(Math.max(1, width - 2)).map((line) => `${verticalBorder}${line}${verticalBorder}`);
          const horizontalBorder = new DynamicBorder((line) => theme.fg("borderAccent", line));
          return [
            ...horizontalBorder.render(width),
            ...framedContent,
            ...horizontalBorder.render(width),
          ].slice(0, height);
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
          } else if (data === "a" && (page === "tasks" || page === "detail")) {
            if (page === "tasks") selectedTaskId = list.getSelectedItem()?.value ?? selectedTaskId;
            actionOrigin = page;
            page = "actions";
            scroll = 0;
            notice = "";
          }
          else if (data === "d" && page !== "technical") { technicalOrigin = page; page = "technical"; scroll = 0; }
          else if (page === "detail" || page === "technical") {
            if (matchesKey(data, Key.up)) scroll = Math.max(0, scroll - 1);
            else if (matchesKey(data, Key.down)) scroll += 1;
            else if (matchesKey(data, Key.pageUp)) scroll = Math.max(0, scroll - pageSize);
            else if (matchesKey(data, Key.pageDown)) scroll += pageSize;
          } else {
            list.handleInput(data);
            if (page === "tasks") selectedTaskId = list.getSelectedItem()?.value ?? selectedTaskId;
          }
          tui.requestRender();
        },
        handleMouse(event: Parameters<SelectList["handleMouse"]>[0]) {
          refresh();
          if (page !== "tasks" && page !== "actions") return undefined;
          if (event.width > 0 && (event.x < 2 || event.x >= event.width - 2)) return undefined;
          const row = event.y - taskListTop;
          if (row < 0 || row >= taskListHeight) return undefined;
          const result = list.handleMouse({ ...event, y: row });
          if (page === "tasks") selectedTaskId = list.getSelectedItem()?.value ?? selectedTaskId;
          tui.requestRender();
          return result;
        },
      };
    }, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "95%", margin: 1 } });
  } finally { if (timer) clearInterval(timer); }
}
