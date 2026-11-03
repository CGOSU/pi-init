import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { initProjectParameters } from "./contracts.ts";

type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");
type ScaffoldOutcome = Awaited<ReturnType<ScaffoldRuntime["runScaffold"]>>;

export function registerProjectTool(pi: ExtensionAPI, loadScaffoldRuntime: () => Promise<ScaffoldRuntime>) {
  pi.registerTool({
    name: "init_project",
    label: "Initialize Project",
    description:
      "Generate AGENTS.md, project memory docs, and .pi/role-models.json. The package-published pi-init-role-routing Skill provides shared role semantics; project AGENTS.md references it and no project-level role Skill is generated. AGENTS.md also records the host platform and command conventions detected during initialization. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and use the package-published pi-init-role-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "init_project records the current Pi host platform in AGENTS.md; if the target runs in WSL, a container, or a remote environment, mention that difference and update the generated context.",
      "Use init_project with dryRun=true first when the target project may already contain generated files.",
    ],
    parameters: initProjectParameters,
    renderCall(args, theme) {
      const target = typeof args.targetDir === "string" ? args.targetDir : ".";
      return new Text(
        theme.fg("toolTitle", theme.bold("pi-init ")) + theme.fg("muted", `初始化 ${target}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ScaffoldOutcome | undefined;
      if (!details || !Array.isArray(details.files)) return new Text(theme.fg("error", "初始化失败"), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "已取消初始化"), 0, 0);
      const prefix = details.dryRun ? "预览" : "已生成";
      const lines = [
        theme.fg("success", `✓ ${prefix} ${details.files.length} 个文件`),
        theme.fg("muted", `保留 ${details.preserved.length} 个维护者已有文件`),
      ];
      if (expanded) lines.push(...details.files.map((file) => theme.fg("dim", `  ${file}`)));
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "已取消，没有写入文件。" }], details: {} };
      }

      const targetDir = params.targetDir ?? ".";
      const options = {
        projectName: params.projectName,
        description: params.description,
        language: params.language,
        testCommand: params.testCommand,
        dryRun: params.dryRun,
        roleModels: params.roleModels,
      };
      const scaffold = await loadScaffoldRuntime();
      const result = await scaffold.runScaffold(ctx, targetDir, options, "conflicts");
      const text = scaffold.formatResult(result);

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

}
