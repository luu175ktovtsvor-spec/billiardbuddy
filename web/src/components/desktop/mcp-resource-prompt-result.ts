import { parseStoredToolResult } from "./stored-tool-result";

export interface McpResourceEntry {
  kind: "resource" | "template";
  uri?: string;
  uriTemplate?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  description?: string;
}

export interface McpResourceListResult {
  server: string;
  entries: McpResourceEntry[];
}

export interface McpPromptEntry {
  name: string;
  args: string[];
  description?: string;
}

export interface McpPromptListResult {
  server: string;
  prompts: McpPromptEntry[];
}

export interface McpResourceReadResult {
  server: string;
  uri: string;
  content: string;
}

export interface McpPromptReadResult {
  server: string;
  name: string;
  description?: string;
  messages: { role: string; content: string }[];
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

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

function storedPreview(text: string | undefined | null, tools: string[]): string | null {
  const stored = parseStoredToolResult(text);
  if (!stored || !tools.includes(stored.tool)) return null;
  return [stored.previewHead, stored.previewTail].filter(Boolean).join("\n");
}

function parseDetail(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /(\w+)=([^\s]+)/g;
  for (const match of line.matchAll(pattern)) {
    out[match[1]] = xmlUnescape(match[2]);
  }
  return out;
}

export function parseMcpResourceList(text: string | undefined | null): McpResourceListResult | null {
  const stored = storedPreview(text, ["list_mcp_resources"]);
  if (stored) return parseMcpResourceList(stored);
  if (!text || !text.includes("<mcp_resources")) return null;
  const open = text.match(/<mcp_resources\b([^>]*)>/);
  if (!open) return null;
  const server = attr(open[1] || "", "server");
  const body = block(text, "mcp_resources");
  const entries: McpResourceEntry[] = [];
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("- ")) continue;
    const template = line.startsWith("- template ");
    const details = parseDetail(template ? line.slice("- template ".length) : line.slice(2));
    const description = lines[index + 1]?.startsWith("  ") ? lines[index + 1].trim() : undefined;
    entries.push({
      kind: template ? "template" : "resource",
      uri: details.uri,
      uriTemplate: details.uriTemplate,
      name: details.name,
      mimeType: details.mimeType,
      size: details.size && Number.isFinite(Number(details.size)) ? Number(details.size) : undefined,
      description,
    });
  }
  return server || entries.length > 0 ? { server, entries } : null;
}

export function parseMcpPromptList(text: string | undefined | null): McpPromptListResult | null {
  const stored = storedPreview(text, ["list_mcp_prompts"]);
  if (stored) return parseMcpPromptList(stored);
  if (!text || !text.includes("<mcp_prompts")) return null;
  const open = text.match(/<mcp_prompts\b([^>]*)>/);
  if (!open) return null;
  const server = attr(open[1] || "", "server");
  const body = block(text, "mcp_prompts");
  const prompts: McpPromptEntry[] = [];
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("- ")) continue;
    const detail = line.slice(2);
    const name = detail.match(/name=([^\s]+)/)?.[1] || "";
    const argsText = detail.match(/args=([^\n]+)/)?.[1] || "";
    const description = lines[index + 1]?.startsWith("  ") ? lines[index + 1].trim() : undefined;
    prompts.push({
      name: xmlUnescape(name),
      args: argsText ? argsText.split(",").map((arg) => xmlUnescape(arg.trim())).filter(Boolean) : [],
      description,
    });
  }
  return server || prompts.length > 0 ? { server, prompts } : null;
}

export function parseMcpResourceRead(text: string | undefined | null): McpResourceReadResult | null {
  const stored = storedPreview(text, ["read_mcp_resource"]);
  if (stored) return parseMcpResourceRead(stored);
  if (!text || !text.includes("<mcp_resource_result")) return null;
  const open = text.match(/<mcp_resource_result\b([^>]*)>/);
  if (!open) return null;
  return {
    server: attr(open[1] || "", "server"),
    uri: attr(open[1] || "", "uri"),
    content: block(text, "mcp_resource_result"),
  };
}

export function parseMcpPromptRead(text: string | undefined | null): McpPromptReadResult | null {
  const stored = storedPreview(text, ["read_mcp_prompt"]);
  if (stored) return parseMcpPromptRead(stored);
  if (!text || !text.includes("<mcp_prompt")) return null;
  const open = text.match(/<mcp_prompt\b([^>]*)>/);
  if (!open) return null;
  const body = block(text, "mcp_prompt");
  const messages = [...body.matchAll(/<message\b([^>]*)>\n?([\s\S]*?)\n?<\/message>/g)].map((match) => ({
    role: attr(match[1] || "", "role"),
    content: xmlUnescape(match[2].trim()),
  }));
  return {
    server: attr(open[1] || "", "server"),
    name: attr(open[1] || "", "name"),
    description: attr(open[1] || "", "description") || undefined,
    messages,
  };
}
