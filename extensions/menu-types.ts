import type { RoleModelConfig } from "../src/role-types.ts";

export type MenuItem = {
  value: string;
  label: string;
  description?: string;
};

export type MenuSaveResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type MenuSaveHandler = (selection?: string | RoleModelConfig) => Promise<MenuSaveResult | void> | MenuSaveResult | void;

export type MenuOptions = {
  summary?: string[];
  maxVisible?: number;
  selectedValue?: string;
  onSave?: MenuSaveHandler;
};
