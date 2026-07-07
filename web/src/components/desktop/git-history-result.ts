export interface GitHistoryCommit {
  sha: string;
  shortSha: string;
  author?: string;
  date?: string;
  title: string;
}

export interface GitHistoryResult {
  isGit: boolean;
  status?: "completed" | "invalid_rev" | "error";
  stored?: {
    path?: string;
    chars?: number;
    bytes?: number;
    previewHead?: string;
    previewTail?: string;
  };
  rev?: string;
  count?: number;
  patchRequested?: boolean;
  message?: string;
  commits: GitHistoryCommit[];
  patch?: {
    text: string;
    bytes?: number;
    limit?: number;
    truncated: boolean;
    exitCode?: number;
  };
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function attr(text: string, name: string): string {
  const match = text.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const value = match?.[1] ?? match?.[2];
  return value ? xmlUnescape(value) : "";
}

function boolAttr(text: string, name: string): boolean {
  return attr(text, name) === "true";
}

function numAttr(text: string, name: string): number | undefined {
  const n = Number(attr(text, name));
  return Number.isFinite(n) ? n : undefined;
}

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

export function parseGitHistoryResult(text: string | undefined | null): GitHistoryResult | null {
  if (!text) return null;
  const stored = parseStoredGitHistory(text);
  if (stored) return stored;
  if (!text.includes("<git_history")) return null;
  const open = text.match(/<git_history\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const isGit = attr(attrs, "is_git") === "true";
  if (!isGit) {
    return {
      isGit: false,
      message: block(text, "git_history") || "当前工作区不是 git 仓库。",
      commits: [],
    };
  }

  const commits: GitHistoryCommit[] = [];
  const commitRe = /<commit\b([^>]*)>\s*<title>\s*([\s\S]*?)\s*<\/title>\s*<\/commit>/g;
  for (const match of text.matchAll(commitRe)) {
    const commitAttrs = match[1] || "";
    const sha = attr(commitAttrs, "sha");
    const shortSha = attr(commitAttrs, "short_sha");
    const title = xmlUnescape((match[2] || "").trim());
    if (!sha && !shortSha && !title) continue;
    commits.push({
      sha,
      shortSha,
      author: attr(commitAttrs, "author") || undefined,
      date: attr(commitAttrs, "date") || undefined,
      title,
    });
  }

  const patchOpen = text.match(/<patch\b([^>]*)>/);
  const patchAttrs = patchOpen?.[1] || "";
  const patchText = block(text, "patch");
  const status = attr(attrs, "status") as GitHistoryResult["status"] | undefined;
  const message = status && status !== "completed"
    ? block(text, "git_history")
    : undefined;
  return {
    isGit: true,
    status,
    rev: attr(attrs, "rev") || undefined,
    count: numAttr(attrs, "count"),
    patchRequested: boolAttr(attrs, "patch"),
    message,
    commits,
    patch: patchOpen ? {
      text: patchText,
      bytes: numAttr(patchAttrs, "bytes"),
      limit: numAttr(patchAttrs, "limit"),
      truncated: boolAttr(patchAttrs, "truncated"),
      exitCode: numAttr(patchAttrs, "exit_code"),
    } : undefined,
  };
}

function parseStoredGitHistory(text: string): GitHistoryResult | null {
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  if (attr(attrs, "tool") !== "git_history") return null;
  const previewHead = block(text, "preview_head");
  const previewTail = block(text, "preview_tail");
  const parsed = parseGitHistoryResult(previewHead) || parseGitHistoryResult(previewTail);
  return {
    ...(parsed || { isGit: true, status: "completed" as const, commits: [] }),
    stored: {
      path: attr(attrs, "path") || undefined,
      chars: numAttr(attrs, "chars"),
      bytes: numAttr(attrs, "bytes"),
      previewHead: previewHead || undefined,
      previewTail: previewTail || undefined,
    },
  };
}
