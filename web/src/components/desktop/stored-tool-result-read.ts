export interface StoredToolResultRead {
  status: "completed" | "missing_store_dir" | "rejected" | "missing" | "not_file" | string;
  agentId?: string;
  path?: string;
  size?: number;
  offset?: number;
  bytes?: number;
  limit?: number;
  truncatedTop?: boolean;
  truncatedBottom?: boolean;
  content: string;
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

function boolAttr(text: string, name: string): boolean {
  return attr(text, name) === "true";
}

export function parseStoredToolResultRead(text: string | undefined | null): StoredToolResultRead | null {
  if (!text || !text.includes("<stored_tool_result_read")) return null;
  const open = text.match(/<stored_tool_result_read\b([^>]*)\/?>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const status = attr(attrs, "status");
  if (!status) return null;
  const body = text.match(/<stored_tool_result_read\b[^>]*>\n?([\s\S]*?)\n?<\/stored_tool_result_read>/)?.[1] || "";
  return {
    status,
    agentId: attr(attrs, "agent_id") || undefined,
    path: attr(attrs, "path") || undefined,
    size: numAttr(attrs, "size"),
    offset: numAttr(attrs, "offset"),
    bytes: numAttr(attrs, "bytes"),
    limit: numAttr(attrs, "limit"),
    truncatedTop: boolAttr(attrs, "truncated_top"),
    truncatedBottom: boolAttr(attrs, "truncated_bottom"),
    content: xmlUnescape(body.trim()),
  };
}
