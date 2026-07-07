export interface FileHistorySnapshot {
  id: string;
  path: string;
  operation: string;
  sequence?: number;
  previousId?: string;
  time?: string;
  size?: number;
  beforeMissing?: boolean;
  skippedReason?: string;
  diff?: string;
  diffError?: string;
}

export interface FileHistoryResult {
  status: "empty" | "found" | "stored";
  snapshots: FileHistorySnapshot[];
  stored?: {
    path?: string;
    chars?: number;
    bytes?: number;
    previewHead?: string;
    previewTail?: string;
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

function numAttr(text: string, name: string): number | undefined {
  const n = Number(attr(text, name));
  return Number.isFinite(n) ? n : undefined;
}

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

function parseSnapshotDiffs(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<snapshot_diff\b([^>]*)>\n?([\s\S]*?)\n?<\/snapshot_diff>/g;
  for (const match of text.matchAll(re)) {
    const id = attr(match[1] || "", "id");
    if (id) out.set(id, (match[2] || "").trim());
  }
  return out;
}

function parseSnapshotDiffErrors(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<snapshot_diff_error\b([^>]*)>\n?([\s\S]*?)\n?<\/snapshot_diff_error>/g;
  for (const match of text.matchAll(re)) {
    const id = attr(match[1] || "", "id");
    if (id) out.set(id, xmlUnescape((match[2] || "").trim()));
  }
  return out;
}

function parseSnapshotLines(text: string): FileHistorySnapshot[] {
  const trimmed = text.trim();
  const diffs = parseSnapshotDiffs(trimmed);
  const diffErrors = parseSnapshotDiffErrors(trimmed);
  const snapshots: FileHistorySnapshot[] = [];
  const lineRe = /^- id:(\S+) path:(.*?) op:(\S+) seq:(\d+)(?: prev:(\S+))? time:(\S+)(?: (?:size:(\d+)|before:missing))?(?: skipped:(.*))?$/;
  for (const line of trimmed.split("\n")) {
    const match = line.match(lineRe);
    if (!match) continue;
    const id = match[1];
    snapshots.push({
      id,
      path: match[2],
      operation: match[3],
      sequence: Number(match[4]) || undefined,
      previousId: match[5] || undefined,
      time: match[6] || undefined,
      size: match[7] ? Number(match[7]) : undefined,
      beforeMissing: line.includes(" before:missing"),
      skippedReason: match[8] || undefined,
      diff: id ? diffs.get(id) : undefined,
      diffError: id ? diffErrors.get(id) : undefined,
    });
  }
  return snapshots;
}

function uniqueSnapshots(snapshots: FileHistorySnapshot[]): FileHistorySnapshot[] {
  const seen = new Set<string>();
  const out: FileHistorySnapshot[] = [];
  for (const snapshot of snapshots) {
    if (seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    out.push(snapshot);
  }
  return out;
}

function parseStoredFileHistory(text: string): FileHistoryResult | null {
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  if (attr(attrs, "tool") !== "file_history") return null;
  const previewHead = block(text, "preview_head");
  const previewTail = block(text, "preview_tail");
  return {
    status: "stored",
    snapshots: uniqueSnapshots([
      ...parseSnapshotLines(previewHead),
      ...parseSnapshotLines(previewTail),
    ]),
    stored: {
      path: attr(attrs, "path") || undefined,
      chars: numAttr(attrs, "chars"),
      bytes: numAttr(attrs, "bytes"),
      previewHead: previewHead || undefined,
      previewTail: previewTail || undefined,
    },
  };
}

export function parseFileHistoryResult(text: string | undefined | null): FileHistoryResult | null {
  if (!text) return null;
  const stored = parseStoredFileHistory(text);
  if (stored) return stored;

  const trimmed = text.trim();
  if (trimmed === "没有文件历史快照。") return { status: "empty", snapshots: [] };
  if (!/(^|\n)- id:/.test(trimmed)) return null;
  const snapshots = parseSnapshotLines(trimmed);
  return snapshots.length > 0 ? { status: "found", snapshots } : null;
}
