import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function getSessionEntries(ctx: ExtensionContext) {
  return ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
}
