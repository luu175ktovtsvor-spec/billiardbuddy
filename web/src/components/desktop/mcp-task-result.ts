import { parseStoredToolResult } from "./stored-tool-result";

export interface McpTaskTraceItem {
  kind: "task" | "progress" | "raw";
  event?: string;
  id?: string;
  status?: string;
  message?: string;
  progress?: number;
  total?: number;
  raw?: string;
}

export interface McpTaskResult {
  server: string;
  tool: string;
  isError: boolean;
  trace: McpTaskTraceItem[];
  result: string;
}

export interface McpResult {
  server: string;
  tool: string;
  isError: boolean;
  result: string;
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
  const value = attr(text, name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

function storedPreview(text: string | undefined | null, predicate: (tool: string) => boolean): string | null {
  const stored = parseStoredToolResult(text);
  if (!stored || !predicate(stored.tool)) return null;
  return [stored.previewHead, stored.previewTail].filter(Boolean).join("\n");
}

function parseTraceLine(line: string): McpTaskTraceItem {
  if (line.startsWith("<mcp_task")) {
    return {
      kind: "task",
      event: attr(line, "event"),
      id: attr(line, "id"),
      status: attr(line, "status"),
      message: attr(line, "message"),
    };
  }
  if (line.startsWith("<mcp_progress")) {
    return {
      kind: "progress",
      progress: numAttr(line, "progress"),
      total: numAttr(line, "total"),
      message: attr(line, "message"),
    };
  }
  return { kind: "raw", raw: xmlUnescape(line) };
}

export function parseMcpTaskResult(text: string | undefined | null): McpTaskResult | null {
  const stored = storedPreview(text, (tool) => tool.startsWith("mcp__"));
  if (stored) return parseMcpTaskResult(stored);
  if (!text || !text.includes("<mcp_task_trace")) return null;
  const traceOpen = text.match(/<mcp_task_trace\b([^>]*)>/);
  if (!traceOpen) return null;
  const resultOpen = text.match(/<mcp_result\b([^>]*)>/);
  const traceAttrs = traceOpen[1] || "";
  const resultAttrs = resultOpen?.[1] || "";
  const server = attr(traceAttrs, "server") || attr(resultAttrs, "server");
  const tool = attr(traceAttrs, "tool") || attr(resultAttrs, "tool");
  if (!server && !tool) return null;
  const trace = block(text, "mcp_task_trace")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseTraceLine);
  return {
    server,
    tool,
    isError: attr(resultAttrs, "isError") === "true",
    trace,
    result: block(text, "mcp_result"),
  };
}

export function parseMcpResult(text: string | undefined | null): McpResult | null {
  const stored = storedPreview(text, (tool) => tool.startsWith("mcp__"));
  if (stored) return parseMcpResult(stored);
  if (!text || !text.includes("<mcp_result")) return null;
  const resultOpen = text.match(/<mcp_result\b([^>]*)>/);
  if (!resultOpen) return null;
  const resultAttrs = resultOpen[1] || "";
  const server = attr(resultAttrs, "server");
  const tool = attr(resultAttrs, "tool");
  if (!server && !tool) return null;
  return {
    server,
    tool,
    isError: attr(resultAttrs, "isError") === "true",
    result: block(text, "mcp_result"),
  };
}
