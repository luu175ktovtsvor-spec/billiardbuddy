export interface GitStatusResult {
  isGit: boolean;
  stored?: {
    path?: string;
    chars?: number;
    bytes?: number;
    previewHead?: string;
    previewTail?: string;
  };
  branch?: string;
  staged: boolean;
  scope?: "worktree" | "staged" | "both" | string;
  summary?: GitStatusSummary;
  status: string;
  diffStat: string;
  stagedDiffStat?: string;
  diff?: {
    text: string;
    bytes?: number;
    limit?: number;
    truncated: boolean;
  };
  stagedDiff?: {
    text: string;
    bytes?: number;
    limit?: number;
    truncated: boolean;
  };
  untrackedFiles: GitStatusUntrackedFile[];
  untrackedTruncated?: boolean;
}

export interface GitStatusSummary {
  files: number;
  staged: number;
  worktree: number;
  untracked: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  copied: number;
  conflicted: number;
  clean: boolean;
}

export interface GitStatusUntrackedFile {
  path: string;
  size?: number;
  bytes?: number;
  truncated: boolean;
  binary: boolean;
  error?: string;
  content: string;
}

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

function attr(text: string, name: string): string {
  const match = text.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1] ? xmlUnescape(match[1]) : "";
}

function boolAttr(text: string, name: string): boolean {
  return attr(text, name) === "true";
}

function numAttr(text: string, name: string): number | undefined {
  const n = Number(attr(text, name));
  return Number.isFinite(n) ? n : undefined;
}

export function parseGitStatusResult(text: string | undefined | null): GitStatusResult | null {
  if (!text) return null;
  const stored = parseStoredGitStatus(text);
  if (stored) return stored;
  if (!text.includes("<git_status")) return null;
  const open = text.match(/<git_status\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const isGit = boolAttr(attrs, "is_git");
  if (!isGit) {
    return {
      isGit: false,
      staged: false,
      status: block(text, "git_status") || "当前工作区不是 git 仓库。",
      diffStat: "",
      untrackedFiles: [],
    };
  }

  const diffOpen = text.match(/<diff\b([^>]*)>/);
  const diffAttrs = diffOpen?.[1] || "";
  const diffText = block(text, "diff");
  const stagedDiffOpen = text.match(/<staged_diff\b([^>]*)>/);
  const stagedDiffAttrs = stagedDiffOpen?.[1] || "";
  const stagedDiffText = block(text, "staged_diff");
  const untrackedOpen = text.match(/<untracked_files\b([^>]*)>/);
  const untrackedAttrs = untrackedOpen?.[1] || "";
  const summaryOpen = text.match(/<summary\b([^>]*)\/>/);
  return {
    isGit: true,
    branch: attr(attrs, "branch") || undefined,
    staged: boolAttr(attrs, "staged"),
    scope: attr(attrs, "scope") || undefined,
    summary: summaryOpen ? parseSummary(summaryOpen[1] || "") : undefined,
    status: block(text, "status") || "(clean)",
    diffStat: block(text, "diff_stat") || "(no diff)",
    stagedDiffStat: block(text, "staged_diff_stat") || undefined,
    untrackedFiles: parseUntrackedFiles(text),
    untrackedTruncated: untrackedOpen ? boolAttr(untrackedAttrs, "truncated") : undefined,
    diff: diffOpen ? {
      text: diffText,
      bytes: numAttr(diffAttrs, "bytes"),
      limit: numAttr(diffAttrs, "limit"),
      truncated: boolAttr(diffAttrs, "truncated"),
    } : undefined,
    stagedDiff: stagedDiffOpen ? {
      text: stagedDiffText,
      bytes: numAttr(stagedDiffAttrs, "bytes"),
      limit: numAttr(stagedDiffAttrs, "limit"),
      truncated: boolAttr(stagedDiffAttrs, "truncated"),
    } : undefined,
  };
}

function parseSummary(attrs: string): GitStatusSummary {
  return {
    files: numAttr(attrs, "files") ?? 0,
    staged: numAttr(attrs, "staged") ?? 0,
    worktree: numAttr(attrs, "worktree") ?? 0,
    untracked: numAttr(attrs, "untracked") ?? 0,
    modified: numAttr(attrs, "modified") ?? 0,
    added: numAttr(attrs, "added") ?? 0,
    deleted: numAttr(attrs, "deleted") ?? 0,
    renamed: numAttr(attrs, "renamed") ?? 0,
    copied: numAttr(attrs, "copied") ?? 0,
    conflicted: numAttr(attrs, "conflicted") ?? 0,
    clean: boolAttr(attrs, "clean"),
  };
}

function parseStoredGitStatus(text: string): GitStatusResult | null {
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  if (attr(attrs, "tool") !== "git_status") return null;
  const previewHead = block(text, "preview_head");
  const previewTail = block(text, "preview_tail");
  const parsed = parseGitStatusResult(previewHead) || parseGitStatusResult(previewTail);
  return {
    ...(parsed || { isGit: true, staged: false, status: "(stored)", diffStat: "(stored)", untrackedFiles: [] }),
    stored: {
      path: attr(attrs, "path") || undefined,
      chars: numAttr(attrs, "chars"),
      bytes: numAttr(attrs, "bytes"),
      previewHead: previewHead || undefined,
      previewTail: previewTail || undefined,
    },
  };
}

function parseUntrackedFiles(text: string): GitStatusUntrackedFile[] {
  const files: GitStatusUntrackedFile[] = [];
  const fileRe = /<file\b([^>]*?)(?:\/>|>\n?([\s\S]*?)\n?<\/file>)/g;
  const untrackedBlock = text.match(/<untracked_files\b[^>]*>\n?([\s\S]*?)\n?<\/untracked_files>/)?.[1] || "";
  for (const match of untrackedBlock.matchAll(fileRe)) {
    const attrs = match[1] || "";
    const path = attr(attrs, "path");
    if (!path) continue;
    files.push({
      path,
      size: numAttr(attrs, "size"),
      bytes: numAttr(attrs, "bytes"),
      truncated: boolAttr(attrs, "truncated"),
      binary: boolAttr(attrs, "binary"),
      error: attr(attrs, "error") || undefined,
      content: match[2] ? xmlUnescape(match[2].trim()) : "",
    });
  }
  return files;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
