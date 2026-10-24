import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MIN_BLANK_OUTPUT_RUN = 256;
const MIN_BLANK_OUTPUT_SHARE = 0.9;
const BLANK_OUTPUT_LINE = /^text\s*\(\s*(?:"[ \t]*"|'[ \t]*')\s*\)\s*;?$/;

type LexicalFrame =
  | { kind: "code"; braces: number }
  | { kind: "string"; quote: string }
  | { kind: "template" }
  | { kind: "comment" };

type RepetitionAssessment =
  | { ok: true }
  | {
      ok: false;
      code: "CODEMODE_REPETITIVE_BLANK_OUTPUT";
      message: string;
      repeatedLines: number;
      longestRun: number;
      nonemptyLines: number;
    };

// Track multiline data so literal/comment examples are not mistaken for output statements.
// This is a conservative lexical heuristic, not JavaScript validation or a security parser.
function advanceLexicalFrames(line: string, frames: LexicalFrame[]): "tracked" | "ambiguous-slash" {
  for (let i = 0; i < line.length; i++) {
    const frame = frames.at(-1)!;
    const char = line[i];
    const next = line[i + 1];
    if (frame.kind === "comment") {
      if (char === "*" && next === "/") { frames.pop(); i++; }
    } else if (frame.kind === "string") {
      if (char === "\\") i++;
      else if (char === frame.quote) frames.pop();
    } else if (frame.kind === "template") {
      if (char === "\\") i++;
      else if (char === "`") frames.pop();
      else if (char === "$" && next === "{") { frames.push({ kind: "code", braces: 1 }); i++; }
    } else {
      if (char === "/" && next === "/") break;
      if (char === "/" && next === "*") { frames.push({ kind: "comment" }); i++; }
      // Distinguishing regex literals from division needs a parser. Decline this heuristic
      // rather than misclassify quotes/backticks inside a regex as multiline data boundaries.
      else if (char === "/") return "ambiguous-slash";
      else if (char === "'" || char === '"') frames.push({ kind: "string", quote: char });
      else if (char === "`") frames.push({ kind: "template" });
      else if (frames.length > 1 && char === "{") frame.braces++;
      else if (frames.length > 1 && char === "}" && --frame.braces === 0) frames.pop();
    }
  }
  return "tracked";
}

export function assessCodemodeRepetition(source: string): RepetitionAssessment {
  const frames: LexicalFrame[] = [{ kind: "code", braces: 0 }];
  let nonemptyLines = 0;
  let repeatedLines = 0;
  let run = 0;
  let longestRun = 0;
  for (const line of source.split(/\r\n|[\n\r\u2028\u2029]/)) {
    const trimmed = line.trim();
    if (trimmed) nonemptyLines++;
    const repeated = frames.length === 1 && BLANK_OUTPUT_LINE.test(trimmed);
    if (advanceLexicalFrames(line, frames) === "ambiguous-slash") return { ok: true };
    if (repeated) {
      repeatedLines++;
      longestRun = Math.max(longestRun, ++run);
    } else run = 0;
  }
  if (longestRun < MIN_BLANK_OUTPUT_RUN || repeatedLines < nonemptyLines * MIN_BLANK_OUTPUT_SHARE) return { ok: true };
  return {
    ok: false,
    code: "CODEMODE_REPETITIVE_BLANK_OUTPUT",
    message: `检测到高度重复的空 text() 输出：最长连续 ${longestRun} 行，占非空行 ${repeatedLines}/${nonemptyLines}；阈值为连续至少 ${MIN_BLANK_OUTPUT_RUN} 行且占比至少 ${MIN_BLANK_OUTPUT_SHARE * 100}%。`,
    repeatedLines,
    longestRun,
    nonemptyLines,
  };
}

export function registerAbnormalToolGuard(pi: ExtensionAPI, stop: (ctx: ExtensionContext) => void) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "codemode" || typeof event.input?.code !== "string") return;
    const assessment = assessCodemodeRepetition(event.input.code);
    if (assessment.ok) return;
    stop(ctx);
    return {
      block: true,
      reason: `[${assessment.code}] ${assessment.message} 本次脚本已在执行前拒绝，未截断、改写或重放；自动续跑已停止。同回合既有副作用仍需核对；此保护不能挽回已经发生的生成耗时。`,
    };
  });
}
