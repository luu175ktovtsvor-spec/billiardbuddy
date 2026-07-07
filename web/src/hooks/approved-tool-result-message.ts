const FILE_MUTATION_TOOL_NAMES = new Set(["edit_file", "write_file", "multi_edit_file", "patch_file", "patch_files", "restore_file"]);

export function isFileMutationTool(tool: string): boolean {
  return FILE_MUTATION_TOOL_NAMES.has(tool);
}

export type FileChangeArtifact =
  | { kind: "file_pending"; title?: string; path: string; tool: string }
  | { kind: "file_pending_list"; title?: string; paths: string[]; tool: string }
  | { kind: "diff"; title?: string; path: string; backupPath?: string }
  | { kind: "diff_list"; title?: string; changes: FileChangeEntry[] }
  | { kind: "file_error"; title?: string; path: string; tool: string; message: string }
  | { kind: "file_error_list"; title?: string; paths: string[]; tool: string; message: string };

export type FileChangeEntry = { path: string; backupPath?: string };

function fileMutationTitle(tool: string, phase: "pending" | "done"): string {
  const verb = tool === "write_file"
    ? "写入"
    : tool === "restore_file"
      ? "恢复"
    : tool === "patch_file"
      ? "应用补丁"
      : tool === "patch_files"
        ? "应用多文件补丁"
        : tool === "multi_edit_file"
          ? "批量修改"
          : "修改";
  if (phase === "pending") return `正在${verb}文件`;
  return tool === "restore_file" ? "文件恢复对比" : "文件改动预览";
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attrFromTag(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const value = match?.[1] ?? match?.[2];
  return value ? decodeAttr(value) : undefined;
}

function pathsFromMutationArgs(args?: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const path = value.trim();
    if (!out.includes(path)) out.push(path);
  };
  push(args?.path);
  const patches = Array.isArray(args?.patches) ? args.patches : [];
  for (const item of patches) {
    if (!item || typeof item !== "object") continue;
    push((item as { path?: unknown }).path);
  }
  return out;
}

function mutationErrorMessage(content: string): string {
  return content.replace(/^错误:/, "").trim() || "工具没有返回文件改动。";
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "y";
}

function restoreFileEntryFromContent(content: string): FileChangeEntry | null {
  const match = content.match(/<restore_file\b([^>]*)>/);
  if (!match) return null;
  const attrs = match[1] ?? "";
  const path = attrFromTag(attrs, "path");
  if (!path) return null;
  return { path, backupPath: attrFromTag(attrs, "backup_path") };
}

export function fileChangeEntriesFromContent(content: string): FileChangeEntry[] {
  const out: FileChangeEntry[] = [];
  const tags = content.matchAll(/<file_change\b([^>]*)\/?>/g);
  for (const tag of tags) {
    const attrs = tag[1] ?? "";
    const path = attrFromTag(attrs, "path");
    if (!path) continue;
    out.push({ path, backupPath: attrFromTag(attrs, "backup_path") });
  }
  return out;
}

export function pendingFileArtifactFromToolCall(tool: string, args?: Record<string, unknown>): FileChangeArtifact | null {
  if (!isFileMutationTool(tool)) return null;
  if (tool === "restore_file" && truthy(args?.dry_run)) return null;
  const paths = pathsFromMutationArgs(args);
  if (tool === "patch_files" && paths.length > 1) {
    return { kind: "file_pending_list", title: "正在应用多文件补丁", paths, tool };
  }
  const path = paths[0];
  if (!path) return null;
  return { kind: "file_pending", title: fileMutationTitle(tool, "pending"), path, tool };
}

export function fileArtifactFromToolResult(tool: string, content: string, args?: Record<string, unknown>): FileChangeArtifact | null {
  if (!isFileMutationTool(tool)) return null;
  if (tool === "restore_file") {
    if (truthy(args?.dry_run) || content.includes("<restore_preview")) return null;
    const argPath = pathsFromMutationArgs(args)[0] || "";
    const change = restoreFileEntryFromContent(content);
    if (!change?.path) {
      if (!argPath) return null;
      return {
        kind: "file_error",
        title: "文件未恢复",
        path: argPath,
        tool,
        message: mutationErrorMessage(content),
      };
    }
    if (!change.backupPath) {
      return {
        kind: "file_error",
        title: "文件已恢复",
        path: change.path,
        tool,
        message: "恢复已完成，但没有可用于右侧对比的恢复前备份。",
      };
    }
    return {
      kind: "diff",
      title: fileMutationTitle(tool, "done"),
      path: change.path,
      backupPath: change.backupPath,
    };
  }
  const changes = fileChangeEntriesFromContent(content);
  const argPaths = pathsFromMutationArgs(args);
  const path = changes[0]?.path || argPaths[0] || "";
  if (!path) return null;
  if (changes.length === 0) {
    const message = mutationErrorMessage(content);
    if (argPaths.length > 1) {
      return {
        kind: "file_error_list",
        title: "多个文件未修改",
        paths: argPaths,
        tool,
        message,
      };
    }
    return {
      kind: "file_error",
      title: "文件未修改",
      path,
      tool,
      message,
    };
  }
  if (changes.length > 1) {
    return {
      kind: "diff_list",
      title: fileMutationTitle(tool, "done"),
      changes,
    };
  }
  return {
    kind: "diff",
    title: fileMutationTitle(tool, "done"),
    path: changes[0]!.path,
    backupPath: changes[0]!.backupPath,
  };
}

export type ApprovedToolResultMessage = {
  role: "assistant";
  content: string;
  kind?: "command" | "video";
  steps?: Array<{
    tool: string;
    args?: Record<string, unknown>;
    result?: string;
    done: boolean;
  }>;
};

function isStoredToolResult(result: string): boolean {
  return result.includes("<stored_tool_result");
}

export function approvedToolResultMessage(tool: string, args: Record<string, unknown>, result: string): ApprovedToolResultMessage {
  if (isStoredToolResult(result)) {
    return {
      role: "assistant",
      content: "",
      steps: [{ tool, args, result, done: true }],
    };
  }
  if (tool === "run_command") return { role: "assistant", content: result, kind: "command" };
  if (tool === "generate_video") return { role: "assistant", content: result, kind: "video" };
  if (isFileMutationTool(tool)) {
    return {
      role: "assistant",
      content: "",
      steps: [{ tool, args, result, done: true }],
    };
  }
  return { role: "assistant", content: result };
}
