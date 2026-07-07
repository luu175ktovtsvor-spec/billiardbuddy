export interface StoredToolResult {
  tool: string;
  callId?: string;
  path?: string;
  storageError?: string;
  chars?: number;
  bytes?: number;
  previewHead: string;
  previewTail: string;
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

export function parseStoredToolResult(text: string | undefined | null): StoredToolResult | null {
  if (!text || !text.includes("<stored_tool_result")) return null;
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const tool = attr(attrs, "tool");
  if (!tool) return null;
  return {
    tool,
    callId: attr(attrs, "call_id") || undefined,
    path: attr(attrs, "path") || undefined,
    storageError: attr(attrs, "storage_error") || undefined,
    chars: numAttr(attrs, "chars"),
    bytes: numAttr(attrs, "bytes"),
    previewHead: block(text, "preview_head"),
    previewTail: block(text, "preview_tail"),
  };
}
