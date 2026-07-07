export type ProjectDiagnosticsStatus =
  | "completed"
  | "missing_package_json"
  | "invalid_package_json"
  | "missing_script"
  | "rejected"
  | "invalid_test_path"
  | "stored";

export interface ProjectDiagnosticsResult {
  status: ProjectDiagnosticsStatus;
  packagePath?: string;
  cwd?: string;
  start?: string;
  check?: string;
  script?: string;
  manager?: string;
  exitCode?: number;
  elapsedMs?: number;
  timedOut?: boolean;
  truncated?: boolean;
  command?: string;
  output?: string;
  reason?: string;
  error?: string;
  available?: string[];
  testTargets?: string[];
  testSuggestions?: Array<{
    path: string;
    cwd?: string;
    command?: string;
  }>;
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

function boolAttr(text: string, name: string): boolean | undefined {
  const value = attr(text, name);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function numAttr(text: string, name: string): number | undefined {
  const n = Number(attr(text, name));
  return Number.isFinite(n) ? n : undefined;
}

function block(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`));
  return match?.[1] ? xmlUnescape(match[1].trim()) : "";
}

function parseStoredDiagnostics(text: string): ProjectDiagnosticsResult | null {
  const open = text.match(/<stored_tool_result\b([^>]*)>/);
  if (!open) return null;
  const attrs = open[1] || "";
  if (attr(attrs, "tool") !== "project_diagnostics") return null;
  const previewHead = block(text, "preview_head");
  const previewTail = block(text, "preview_tail");
  const parsedHead = parseProjectDiagnosticsResult(previewHead);
  return {
    ...(parsedHead || { status: "stored" as const }),
    status: parsedHead?.status || "stored",
    truncated: true,
    stored: {
      path: attr(attrs, "path") || undefined,
      chars: numAttr(attrs, "chars"),
      bytes: numAttr(attrs, "bytes"),
      previewHead: previewHead || undefined,
      previewTail: previewTail || undefined,
    },
  };
}

function parseTestTargets(text: string): string[] | undefined {
  const body = text.match(/<test_targets\b[^>]*>\n?([\s\S]*?)\n?<\/test_targets>/)?.[1] || "";
  if (!body) return undefined;
  const targets = Array.from(body.matchAll(/<target\b([^>]*)\/>/g))
    .map((match) => attr(match[1] || "", "path"))
    .filter(Boolean);
  return targets.length ? targets : undefined;
}

function parseTestSuggestions(text: string): ProjectDiagnosticsResult["testSuggestions"] {
  const body = text.match(/<test_suggestions\b[^>]*>\n?([\s\S]*?)\n?<\/test_suggestions>/)?.[1] || "";
  if (!body) return undefined;
  const suggestions: NonNullable<ProjectDiagnosticsResult["testSuggestions"]> = [];
  for (const match of body.matchAll(/<suggestion\b([^>]*)\/>/g)) {
    const attrs = match[1] || "";
    const path = attr(attrs, "path");
    if (!path) continue;
    const cwd = attr(attrs, "cwd");
    const command = attr(attrs, "command");
    suggestions.push({
      path,
      cwd: cwd || undefined,
      command: command || undefined,
    });
  }
  return suggestions.length ? suggestions : undefined;
}

export function parseProjectDiagnosticsResult(text: string | undefined | null): ProjectDiagnosticsResult | null {
  if (!text) return null;
  const stored = parseStoredDiagnostics(text);
  if (stored) return stored;

  const open = text.match(/<project_diagnostics\b([^>]*)\/?>/);
  if (!open) return null;
  const attrs = open[1] || "";
  const status = attr(attrs, "status") as ProjectDiagnosticsStatus;
  if (!status) return null;

  const result: ProjectDiagnosticsResult = {
    status,
    packagePath: attr(attrs, "package") || undefined,
    cwd: attr(attrs, "cwd") || undefined,
    start: attr(attrs, "start") || undefined,
    check: attr(attrs, "check") || undefined,
    script: attr(attrs, "script") || undefined,
    manager: attr(attrs, "manager") || undefined,
    exitCode: numAttr(attrs, "exit_code"),
    elapsedMs: numAttr(attrs, "elapsed_ms"),
    timedOut: boolAttr(attrs, "timed_out"),
    truncated: boolAttr(attrs, "truncated"),
    reason: attr(attrs, "reason") || undefined,
    error: attr(attrs, "error") || undefined,
  };

  const available = attr(attrs, "available");
  if (available) result.available = available.split(",").map((item) => item.trim()).filter(Boolean);
  result.testTargets = parseTestTargets(text);
  result.testSuggestions = parseTestSuggestions(text);
  const command = block(text, "command");
  if (command) result.command = command;
  const output = block(text, "output");
  if (output) result.output = output;
  if (status === "rejected" && !result.output) {
    const body = text.match(/<project_diagnostics\b[^>]*>\n?([\s\S]*?)\n?<\/project_diagnostics>/)?.[1]?.trim();
    if (body) result.output = xmlUnescape(body);
  }
  return result;
}
