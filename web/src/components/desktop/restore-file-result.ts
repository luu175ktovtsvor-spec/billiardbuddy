export interface RestoreFileResult {
  status: "preview" | "restored" | "stored";
  snapshotId?: string;
  path?: string;
  diff: string;
  stored?: {
    resultPath?: string;
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

function parseInlineRestore(text: string): RestoreFileResult | null {
  if (!text || (!text.includes("<restore_preview") && !text.includes("<restore_file"))) return null;
  const match = text.match(/<(restore_preview|restore_file)\b([^>]*)>\n?([\s\S]*?)\n?<\/\1>/);
  if (!match) return null;
  const tag = match[1];
  const attrs = match[2] || "";
  return {
    status: tag === "restore_preview" ? "preview" : "restored",
    snapshotId: attr(attrs, "snapshot_id") || undefined,
    path: attr(attrs, "path") || undefined,
    diff: (match[3] || "").trim(),
  };
}

function parseStoredRestoreFile(text: string): RestoreFileResult | null {
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  if (attr(attrs, "tool") !== "restore_file") return null;
  const previewHead = block(text, "preview_head");
  const previewTail = block(text, "preview_tail");
  const parsed = parseInlineRestore(previewHead) || parseInlineRestore(previewTail);
  return {
    ...(parsed || { status: "stored" as const, diff: previewTail || previewHead || "" }),
    status: parsed?.status || "stored",
    stored: {
      resultPath: attr(attrs, "path") || undefined,
      chars: numAttr(attrs, "chars"),
      bytes: numAttr(attrs, "bytes"),
      previewHead: previewHead || undefined,
      previewTail: previewTail || undefined,
    },
  };
}

export function parseRestoreFileResult(text: string | undefined | null): RestoreFileResult | null {
  if (!text) return null;
  return parseStoredRestoreFile(text) || parseInlineRestore(text);
}
