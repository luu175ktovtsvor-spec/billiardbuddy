export interface GrepRangeInput {
  path: string;
  start_line?: number;
  end_line?: number;
}

export interface GrepRangesResult {
  matches?: number;
  ranges?: number;
  rangeContext?: number;
  readManyFilesInput?: {
    ranges?: GrepRangeInput[];
  };
  matchedLines: string[];
  notes: string[];
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

function parseReadManyFilesInput(value: string): GrepRangesResult["readManyFilesInput"] | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as { ranges?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ranges)) return undefined;
    const ranges = parsed.ranges
      .map((item): GrepRangeInput | null => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        if (typeof record.path !== "string" || !record.path.trim()) return null;
        const start = Number(record.start_line);
        const end = Number(record.end_line);
        return {
          path: record.path,
          start_line: Number.isFinite(start) ? start : undefined,
          end_line: Number.isFinite(end) ? end : undefined,
        };
      })
      .filter((item): item is GrepRangeInput => !!item);
    return ranges.length > 0 ? { ranges } : undefined;
  } catch {
    return undefined;
  }
}

export function parseGrepRangesResult(text: string | undefined | null): GrepRangesResult | null {
  if (!text || !text.includes("<grep_ranges")) return null;
  const open = text.match(/<grep_ranges\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const matchedLines = block(text, "matched_lines")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const notes = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("…[") && line.endsWith("]"));
  return {
    matches: numAttr(attrs, "matches"),
    ranges: numAttr(attrs, "ranges"),
    rangeContext: numAttr(attrs, "range_context"),
    readManyFilesInput: parseReadManyFilesInput(block(text, "read_many_files_input")),
    matchedLines,
    notes,
  };
}
