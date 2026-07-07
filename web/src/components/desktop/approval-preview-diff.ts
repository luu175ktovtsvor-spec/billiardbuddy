export interface ApprovalPreviewDiff {
  before: string;
  after: string;
}

export interface RunCommandApprovalPlan {
  type: "run_command";
  command: string;
  cwd?: string;
  risk?: string;
  timeoutMs?: string;
  maxOutputBytes?: string;
}

export interface ProjectDiagnosticsApprovalPlan {
  type: "project_diagnostics";
  status: string;
  packagePath?: string;
  cwd?: string;
  check?: string;
  script?: string;
  manager?: string;
  command?: string;
  testTargets?: "all" | string[];
  timeoutMs?: string;
  maxOutputBytes?: string;
  available?: string[];
  reason?: string;
  error?: string;
  start?: string;
  body?: string;
}

export type ApprovalPlanPreview = RunCommandApprovalPlan | ProjectDiagnosticsApprovalPlan;

export type ApprovalPreviewState =
  | { kind: "none" }
  | { kind: "stale"; preview: string }
  | { kind: "plan"; plan: ApprovalPlanPreview }
  | { kind: "diff"; diff: ApprovalPreviewDiff }
  | { kind: "text"; preview: string };

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

const RUN_COMMAND_OPEN = "<run_command_preview>";
const RUN_COMMAND_CLOSE = "</run_command_preview>";
const PROJECT_DIAGNOSTICS_OPEN = /^<project_diagnostics_preview\b([^>]*)>/;
const PROJECT_DIAGNOSTICS_CLOSE = "</project_diagnostics_preview>";

export function parseApprovalPreviewDiff(preview: string | undefined | null): ApprovalPreviewDiff | null {
  const text = preview?.replace(/\r\n/g, "\n");
  if (!text || (!HUNK_HEADER.test(text) && !text.includes("\n@@ -"))) return null;

  const before: string[] = [];
  const after: string[] = [];
  let inHunk = false;
  let sawHunk = false;
  let hasChange = false;

  for (const line of text.split("\n")) {
    if (HUNK_HEADER.test(line)) {
      if (sawHunk) {
        before.push("");
        after.push("");
      }
      sawHunk = true;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline")) continue;

    const sign = line[0];
    const body = line.slice(1);
    if (sign === " ") {
      before.push(body);
      after.push(body);
    } else if (sign === "-") {
      before.push(body);
      hasChange = true;
    } else if (sign === "+") {
      after.push(body);
      hasChange = true;
    }
  }

  if (!sawHunk || !hasChange) return null;
  return { before: before.join("\n"), after: after.join("\n") };
}

export function parseApprovalPlanPreview(preview: string | undefined | null): ApprovalPlanPreview | null {
  const text = preview?.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (text.startsWith(RUN_COMMAND_OPEN)) return parseRunCommandPreview(text);
  if (PROJECT_DIAGNOSTICS_OPEN.test(text)) return parseProjectDiagnosticsPreview(text);
  return null;
}

export function approvalPreviewState(preview: string | undefined | null, argsChanged: boolean): ApprovalPreviewState {
  if (!preview) return { kind: "none" };
  if (argsChanged) return { kind: "stale", preview };
  const plan = parseApprovalPlanPreview(preview);
  if (plan) return { kind: "plan", plan };
  const diff = parseApprovalPreviewDiff(preview);
  return diff ? { kind: "diff", diff } : { kind: "text", preview };
}

function parseRunCommandPreview(text: string): RunCommandApprovalPlan | null {
  const body = blockBody(text, RUN_COMMAND_OPEN, RUN_COMMAND_CLOSE);
  if (body == null) return null;
  const fields = parseKeyValueLines(body);
  const command = fields.get("command")?.trim();
  if (!command) return null;
  return {
    type: "run_command",
    command,
    cwd: cleanOptional(fields.get("cwd")),
    risk: cleanOptional(fields.get("risk")),
    timeoutMs: cleanOptional(fields.get("timeout_ms")),
    maxOutputBytes: cleanOptional(fields.get("max_output_bytes")),
  };
}

function parseProjectDiagnosticsPreview(text: string): ProjectDiagnosticsApprovalPlan | null {
  const open = text.match(PROJECT_DIAGNOSTICS_OPEN);
  if (!open) return null;
  const attrs = parseXmlishAttributes(open[1] ?? "");
  const status = attrs.get("status") || "unknown";
  const selfClosing = /^<project_diagnostics_preview\b[^>]*\/>$/.test(text);
  const body = selfClosing ? "" : blockBody(text, open[0], PROJECT_DIAGNOSTICS_CLOSE);
  if (body == null) return null;
  const fields = parseKeyValueLines(body);
  return {
    type: "project_diagnostics",
    status,
    packagePath: cleanOptional(fields.get("package")),
    cwd: cleanOptional(fields.get("cwd")),
    check: cleanOptional(fields.get("check")),
    script: cleanOptional(fields.get("script")),
    manager: cleanOptional(fields.get("manager")),
    command: cleanOptional(fields.get("command")),
    testTargets: parseTestTargets(fields.get("test_targets")),
    timeoutMs: cleanOptional(fields.get("timeout_ms")),
    maxOutputBytes: cleanOptional(fields.get("max_output_bytes")),
    available: parseAvailable(fields.get("available")),
    reason: cleanOptional(fields.get("reason")),
    error: cleanOptional(fields.get("error")),
    start: cleanOptional(attrs.get("start")),
    body: cleanOptional(fields.get("body")),
  };
}

function blockBody(text: string, openTag: string, closeTag: string): string | null {
  if (!text.startsWith(openTag)) return null;
  const end = text.lastIndexOf(closeTag);
  if (end < openTag.length) return null;
  return text.slice(openTag.length, end).trim();
}

function parseKeyValueLines(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  let currentKey: string | null = null;
  for (const line of body.split("\n")) {
    const match = line.match(/^([a-z_]+):(?:\s?(.*))$/);
    if (match) {
      currentKey = match[1]!;
      fields.set(currentKey, match[2] ?? "");
    } else if (currentKey) {
      fields.set(currentKey, `${fields.get(currentKey) ?? ""}\n${line}`);
    }
  }
  return fields;
}

function parseXmlishAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of raw.matchAll(/\s+([a-z_]+)="([^"]*)"/g)) {
    attrs.set(match[1]!, match[2] ?? "");
  }
  return attrs;
}

function parseTestTargets(raw: string | undefined): "all" | string[] | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === "all") return "all";
  const paths = value.split("\n")
    .map(line => line.trim().replace(/^-\s*/, ""))
    .filter(Boolean);
  return paths.length ? paths : undefined;
}

function parseAvailable(raw: string | undefined): string[] | undefined {
  const items = raw?.split(",").map(item => item.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}
