import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Input, Key, matchesKey, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  getRoleNames,
  THINKING_LEVELS,
  filterRoleModels,
  roleLabel,
} from "../src/roles.js";
import type { MenuItem, MenuOptions, RoleModelConfig } from "./contracts.ts";

export const MENU_BACK = "__pi_init_back__" as const;

export function isMenuBack(value: unknown): value is typeof MENU_BACK {
  return value === MENU_BACK;
}

export function formatRoleModel(config: RoleModelConfig) {
  return `${config.provider}/${config.model} · ${config.thinkingLevel}`;
}

function availableThinkingLevels(model: any) {
  return getSupportedThinkingLevels(model).filter((level) =>
    (THINKING_LEVELS as readonly string[]).includes(level),
  );
}

function supportedThinkingText(model: any) {
  const levels = availableThinkingLevels(model);
  return levels.length > 0 ? `推理：${levels.join("/")}` : "";
}

export function shortModelName(model: string) {
  const parts = model.split(/[\\/]/);
  return parts.at(-1) ?? model;
}

export async function showMenu(
  ctx: ExtensionContext,
  title: string,
  items: MenuItem[],
  options: MenuOptions = {},
) {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode !== "tui") {
    const selected = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === selected)?.value;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const list = new SelectList(items, Math.min(items.length, options.maxVisible ?? 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const selectedIndex = options.selectedValue === undefined
      ? -1
      : items.findIndex((item) => item.value === options.selectedValue);
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);

    const content = new Box(2, 0);
    content.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
    content.addChild(new Spacer(1));
    if (options.summary?.length) {
      const summaryText = options.summary.map((line) => ` ${line} `).join("\n");
      content.addChild(
        new Text(theme.fg("text", summaryText), 0, 1, (line) => theme.bg("selectedBg", line)),
      );
    }
    content.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 返回"), 0, 0));
    content.addChild(list);

    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
    container.addChild(content);
    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape)) {
          done(MENU_BACK);
        } else {
          list.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}

export function getAvailableRoleModels(ctx: ExtensionContext) {
  const source =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map(({ model }) => model)
      : ctx.modelRegistry.getAvailable();
  const unique = new Map<string, (typeof source)[number]>();
  for (const model of source) {
    unique.set(`${model.provider}/${model.id}`, model);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
}

/*
 * The role picker lists the full host registry. Role configuration uses exact
 * fully qualified provider/model references instead of an allowlist.
 */
async function selectModelWithSearch(
  ctx: ExtensionContext,
  role: string,
  models: any[],
  selectedModel?: any,
) {
  if (ctx.mode !== "tui") {
    const query = await ctx.ui.input(
      `搜索 ${roleLabel(role)} 的模型（可留空显示全部）`,
      "provider/model 或模型名称",
    );
    if (query === undefined) return undefined;
    const filtered = filterRoleModels(models, query);
    if (filtered.length === 0) {
      throw new Error(`没有匹配“${query.trim()}”的模型，请重新执行配置并调整搜索条件`);
    }
    const labels = filtered.map((model) => {
      const support = supportedThinkingText(model);
      return `${model.provider}/${model.id}${support ? ` · ${support}` : ""}`;
    });
    const selected = await ctx.ui.select(`选择 ${roleLabel(role)} 模型`, labels);
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    return index >= 0 ? filtered[index] : undefined;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    let filteredModels = models;
    let list: SelectList;
    const search = new Input();
    const selectedValue = selectedModel
      ? `${selectedModel.provider}/${selectedModel.id}`
      : undefined;

    const createList = (items: any[]) => {
      const next = new SelectList(
        items.map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.id} [${model.provider}]`,
          description: [model.name, supportedThinkingText(model)].filter(Boolean).join(" · "),
        })),
        Math.min(items.length, 10),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      const selectedIndex = selectedValue === undefined
        ? -1
        : items.findIndex((model) => `${model.provider}/${model.id}` === selectedValue);
      if (selectedIndex >= 0) next.setSelectedIndex(selectedIndex);
      next.onSelect = (item) => done(item.value);
      next.onCancel = () => done(null);
      return next;
    };

    list = createList(filteredModels);
    search.onSubmit = () => {
      const selected = list.getSelectedItem();
      done(selected?.value ?? null);
    };
    search.onEscape = () => done(MENU_BACK);

    const render = (width: number) => {
      const innerWidth = Math.max(1, width - 2);
      return [
        ...new DynamicBorder((text: string) => theme.fg("borderAccent", text)).render(width),
        ...new Text(theme.fg("accent", theme.bold(`选择 ${roleLabel(role)} 模型`)), 1, 0).render(width),
        new Text(theme.fg("dim", "输入关键词即时筛选 · ↑↓ 选择 · Enter 确认 · Esc 返回"), 1, 0).render(width)[0] ?? "",
        ...search.render(innerWidth).map((line) => ` ${line}`),
        ...list.render(innerWidth).map((line) => ` ${line}`),
        ...new DynamicBorder((text: string) => theme.fg("borderAccent", text)).render(width),
      ];
    };

    let focused = false;
    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        search.focused = value;
      },
      render,
      invalidate: () => {
        search.invalidate();
        list.invalidate();
      },
      handleInput: (data: string) => {
        if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
          list.handleInput(data);
        } else if (matchesKey(data, Key.escape)) {
          done(MENU_BACK);
        } else if (matchesKey(data, Key.ctrl("c"))) {
          done(null);
        } else {
          search.handleInput(data);
          filteredModels = filterRoleModels(models, search.getValue());
          list = createList(filteredModels);
        }
        tui.requestRender();
      },
    };
  });

  if (!result) return undefined;
  if (isMenuBack(result)) return MENU_BACK;
  return models.find((model) => `${model.provider}/${model.id}` === result);
}

export async function selectRoleModel(
  ctx: ExtensionContext,
  role: string,
  initialConfig?: RoleModelConfig,
) {
  const models = getAvailableRoleModels(ctx);
  if (models.length === 0) {
    throw new Error("当前没有可用模型；请先配置模型凭据或调整模型范围");
  }

  let selectedModel = initialConfig
    ? models.find((model) => model.provider === initialConfig.provider && model.id === initialConfig.model)
    : undefined;
  while (true) {
    const model = await selectModelWithSearch(ctx, role, models, selectedModel);
    if (isMenuBack(model)) return MENU_BACK;
    if (!model) return undefined;
    const selectedModelLabel = `${model.provider}/${model.id}`;
    const supportedLevels = availableThinkingLevels(model);
    if (supportedLevels.length === 0) {
      throw new Error(`模型 ${selectedModelLabel} 不支持任何可用的 Pi 推理强度`);
    }

    const thinkingLevel = await showMenu(
      ctx,
      `推理强度 · ${shortModelName(model.id)}`,
      supportedLevels.map((level) => ({
        value: level,
        label: level,
        description: level === "max" ? "最高推理强度，耗时和成本也最高" : undefined,
      })),
      {
        selectedValue: selectedModel === model ? initialConfig?.thinkingLevel : undefined,
      },
    );
    if (isMenuBack(thinkingLevel)) {
      selectedModel = model;
      continue;
    }
    if (thinkingLevel === undefined) return undefined;
    if (!supportedLevels.includes(thinkingLevel as (typeof supportedLevels)[number])) {
      throw new Error(`模型 ${selectedModelLabel} 不支持推理强度：${thinkingLevel}`);
    }

    return {
      provider: model.provider,
      model: model.id,
      thinkingLevel,
    } satisfies RoleModelConfig;
  }
}

export async function collectRoleModels(
  ctx: ExtensionContext,
  roles = getRoleNames(undefined),
) {
  const roleModels: Record<string, RoleModelConfig> = {};
  let roleIndex = 0;
  while (roleIndex < roles.length) {
    const role = roles[roleIndex];
    const selection = await selectRoleModel(ctx, role, roleModels[role]);
    if (isMenuBack(selection)) {
      if (roleIndex === 0) return MENU_BACK;
      roleIndex -= 1;
      continue;
    }
    if (!selection) return undefined;
    roleModels[role] = selection;
    roleIndex += 1;
  }
  return roleModels;
}

export async function input(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder: string,
  initialValue?: string,
) {
  if (ctx.mode !== "tui") {
    const value = await ctx.ui.input(title, placeholder);
    return value === undefined ? undefined : value.trim();
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const field = new Input();
    if (initialValue !== undefined) {
      field.setValue(initialValue);
      field.handleInput(String.fromCharCode(5));
    }
    let focused = false;
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(field);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `${placeholder} · Enter 确认 · Esc 返回`), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("borderAccent", text)));

    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        field.focused = value;
      },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, Key.escape)) {
          done(MENU_BACK);
        } else if (matchesKey(data, Key.ctrl("c"))) {
          done(null);
        } else if (matchesKey(data, Key.enter) || data === "\n") {
          done(field.getValue());
        } else {
          field.handleInput(data);
        }
        tui.requestRender();
      },
    };
  });

  return result === null || result === undefined ? undefined : result.trim();
}
