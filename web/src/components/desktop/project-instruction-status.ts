import { parseProjectInstructionScope, type ProjectInstructionScopeResult } from "./project-instruction-scope";

export interface ProjectInstructionStatusStep {
  tool?: string;
  result?: string;
}

export interface ProjectInstructionStatusMessage {
  steps?: ProjectInstructionStatusStep[];
}

export interface WorkspaceProjectInstructionSummaryForStatus {
  files?: Array<{ file: string; truncated?: boolean }>;
  count?: number;
  truncated?: boolean;
}

export interface ProjectInstructionStatus {
  label: string;
  title: string;
  active: boolean;
}

export function latestProjectInstructionScope(
  messages: ProjectInstructionStatusMessage[],
  liveSteps: ProjectInstructionStatusStep[] = [],
): ProjectInstructionScopeResult | null {
  let latest: ProjectInstructionScopeResult | null = null;
  for (const message of messages) {
    for (const step of message.steps || []) {
      if (step.tool !== "list_project_instructions") continue;
      latest = parseProjectInstructionScope(step.result) || latest;
    }
  }
  for (const step of liveSteps) {
    if (step.tool !== "list_project_instructions") continue;
    latest = parseProjectInstructionScope(step.result) || latest;
  }
  return latest;
}

export function projectInstructionStatus(
  workspaceSummary?: WorkspaceProjectInstructionSummaryForStatus | null,
  latestScope?: ProjectInstructionScopeResult | null,
): ProjectInstructionStatus {
  const rootFiles = workspaceSummary?.files || [];
  const rootCount = typeof workspaceSummary?.count === "number" ? workspaceSummary.count : rootFiles.length;
  const scopeCount = latestScope?.status === "found" ? latestScope.files.length : 0;
  const parts: string[] = [];
  const titleParts: string[] = [];

  if (rootCount > 0) {
    parts.push(`根${rootCount}`);
    titleParts.push(`根级规则: ${rootFiles.map(fileLabel).join(", ") || `${rootCount} 个文件`}`);
  } else {
    titleParts.push("根级规则: 未发现 AGENTS.md/CLAUDE.md");
  }

  if (latestScope) {
    if (latestScope.status === "found") {
      parts.push(`scope${scopeCount}`);
      titleParts.push(`最近 scope: ${latestScope.files.map(file => fileLabel(file)).join(", ")}`);
    } else {
      parts.push("scope空");
      titleParts.push(`最近 scope: 未命中${latestScope.targets ? ` (${latestScope.targets})` : ""}`);
    }
    if (latestScope.omitted) titleParts.push(`省略 ${latestScope.omitted} 个目标`);
  }

  return {
    label: parts.length ? `规则:${parts.join(" · ")}` : "规则:无根级",
    title: titleParts.join("\n"),
    active: rootCount > 0 || !!latestScope,
  };
}

function fileLabel(file: { file: string; truncated?: boolean }): string {
  return `${file.file}${file.truncated ? " (截断)" : ""}`;
}
