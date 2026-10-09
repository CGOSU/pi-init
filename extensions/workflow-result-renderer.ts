import type { ReportTheme } from "./contracts.ts";
import { renderWorkflowOperationFailure as renderErrorFailure } from "./workflow-error-renderer.ts";
import { createWorkflowErrorView } from "./workflow-error-view.ts";
import { renderWorkflowCompletion, renderWorkflowTaskCompletion } from "./workflow-completion-renderer.ts";
import { renderWorkflowPauseResult } from "./workflow-pause-renderer.ts";
import { formatWorkflowStatusText, renderWorkflowStatusResult } from "./workflow-status-renderer.ts";
import type { WorkflowPresentation } from "./workflow-presentation.ts";

export function renderWorkflowOperationFailure(content: unknown, theme: ReportTheme) {
  return renderErrorFailure(createWorkflowErrorView(content), theme);
}

export function renderWorkflowPresentation(
  presentation: WorkflowPresentation,
  expanded: boolean,
  theme: ReportTheme,
) {
  switch (presentation.kind) {
    case "workflow-status":
      return presentation.view.kind === "workflow" && presentation.view.status === "paused"
        ? renderWorkflowPauseResult(
            presentation.view.pause,
            expanded,
            theme,
            formatWorkflowStatusText(presentation.view),
          )
        : renderWorkflowStatusResult(presentation.view, expanded, theme);
    case "task-completion":
      return renderWorkflowTaskCompletion(presentation.view, presentation.continuation, theme);
    case "workflow-completion":
      return renderWorkflowCompletion(presentation.view, theme);
  }
}
