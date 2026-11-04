export type FileReviewScanScope = { scope?: string; exclude?: string[]; includeTemporary?: boolean };
export type FileReviewExclusion = { path: string; reason: "temporary-source" | "explicit" };
// Only conventional temporary directories directly under the project root are skipped.
export function isTemporaryReviewDirectory(path: string) {
  return !path.includes("/") && (path === ".tmp" || path.startsWith(".tmp-"));
}

export function isReviewPathWithin(path: string, prefix: string) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

export function reviewPathSelected(path: string, options: FileReviewScanScope) {
  return (!options.scope || isReviewPathWithin(path, options.scope))
    && !options.exclude?.some(prefix => isReviewPathWithin(path, prefix))
    && (options.includeTemporary || !path.includes("/") || !isTemporaryReviewDirectory(path.split("/")[0]!));
}

export function parseLargeScanScope(args: string):
  { ok: true; value: FileReviewScanScope } | { ok: false; message: string } {
  // Paths with spaces may be quoted; these are literal directory prefixes, never shell/glob expressions.
  const tokens = args.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const value: FileReviewScanScope = {};
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (flag === "--include-temporary") { value.includeTemporary = true; continue; }
    if (flag !== "--scope" && flag !== "--exclude") return { ok: false, message: "用法：/large [--scope 项目相对目录] [--exclude 项目相对目录] [--include-temporary]；路径可加引号，排除可重复，不支持 glob。" };
    let path = tokens[++index];
    if (!path) return { ok: false, message: `${flag} 缺少项目相对目录。` };
    if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
    path = path.replace(/^\.\//, "").replace(/\/$/, "");
    if (!path || path.startsWith("/") || path.startsWith("--") || /[\\:*?\[\]"']/.test(path)
      || path.split("/").some(part => !part || part === ".." || part === "." && path !== ".")) {
      return { ok: false, message: `${flag} 必须是项目内的相对目录前缀，不能包含 ..、绝对路径或 glob。` };
    }
    if (flag === "--scope") value.scope = path;
    else (value.exclude ??= []).push(path);
  }
  return { ok: true, value };
}
