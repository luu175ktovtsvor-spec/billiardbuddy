export interface ProjectInstructionFile {
  file: string;
  truncated: boolean;
  excerpt: string;
}

export interface ProjectInstructionScopeResult {
  status: "found" | "empty";
  targets?: string;
  omitted?: number;
  files: ProjectInstructionFile[];
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrFromTag(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const value = match?.[1] ?? match?.[2];
  return value ? decodeXml(value) : undefined;
}

function excerptFor(content: string): string {
  const clean = decodeXml(content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean;
}

export function parseProjectInstructionScope(text: string | undefined | null): ProjectInstructionScopeResult | null {
  if (!text) return null;

  const empty = text.match(/<project_instructions\b([^>]*)\/>/);
  if (empty) {
    const attrs = empty[1] || "";
    const status = attrFromTag(attrs, "status");
    if (status !== "empty") return null;
    const omitted = Number(attrFromTag(attrs, "omitted") || 0);
    return {
      status: "empty",
      targets: attrFromTag(attrs, "targets") || attrFromTag(attrs, "scope"),
      omitted: Number.isFinite(omitted) && omitted > 0 ? omitted : undefined,
      files: [],
    };
  }

  const files: ProjectInstructionFile[] = [];
  const blockRe = /<project_instruction\b([^>]*)>\s*([\s\S]*?)\s*<\/project_instruction>/g;
  for (const match of text.matchAll(blockRe)) {
    const attrs = match[1] || "";
    const file = attrFromTag(attrs, "file");
    if (!file) continue;
    files.push({
      file,
      truncated: attrFromTag(attrs, "truncated") === "true",
      excerpt: excerptFor(match[2] || ""),
    });
  }

  if (!files.length) return null;
  const omittedMatch = text.match(/<project_instructions_omitted\b([^>]*)\/>/);
  const omitted = omittedMatch ? Number(attrFromTag(omittedMatch[1] || "", "count") || 0) : 0;
  return {
    status: "found",
    omitted: Number.isFinite(omitted) && omitted > 0 ? omitted : undefined,
    files,
  };
}
