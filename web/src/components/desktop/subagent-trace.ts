import { buildTraceWindow, normalizeTraceSearchText } from "./trace-view";

export interface SubagentTrace {
  agent?: string;
  agentId?: string;
  task?: string;
  lines: string[];
  finalText?: string;
}

export type SubagentTraceMarkerKind = "warning";

export interface SubagentTraceMarker {
  index: number;
  kind: SubagentTraceMarkerKind;
  label: string;
  detail: string;
  query: string;
}

export type SubagentTracePhaseKind = "start" | "tool" | "progress" | "final" | "warning" | "event";

export interface SubagentTraceLine {
  text: string;
  indexStart: number;
  indexEnd: number;
  phase: SubagentTracePhaseKind;
  phaseLabel: string;
}

export interface SubagentTracePhaseGroup {
  phase: SubagentTracePhaseKind;
  phaseLabel: string;
  count: number;
  indexStart: number;
  indexEnd: number;
}

export interface SubagentTraceViewOptions {
  maxLines?: number;
  query?: string;
}

export interface SubagentTraceView {
  lines: string[];
  lineViews: SubagentTraceLine[];
  phaseGroups: SubagentTracePhaseGroup[];
  markers: SubagentTraceMarker[];
  totalLines: number;
  matchCount: number;
  hiddenLines: number;
  hasQuery: boolean;
}

interface PreparedSubagentLine {
  text: string;
  indexStart: number;
  indexEnd: number;
  phase: SubagentTracePhaseKind;
  phaseLabel: string;
  haystack: string;
}

export interface BackgroundTaskStarted {
  id?: string;
  agentId?: string;
  agent?: string;
  status?: string;
  title: string;
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attrFromTag(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  const value = match?.[1] ?? match?.[2];
  return value ? decodeAttr(value) : undefined;
}

export function parseAgentTaskResult(result?: string): { agent?: string; agentId?: string; finalText: string } | null {
  if (!result) return null;
  const match = result.match(/<agent_task\b([^>]*)>\n?([\s\S]*?)\n?<\/agent_task>/);
  if (!match) return null;
  return {
    agent: attrFromTag(match[1] || "", "agent"),
    agentId: attrFromTag(match[1] || "", "agent_id"),
    finalText: (match[2] || "").trim(),
  };
}

export function subagentProgressLines(progress?: string): string[] {
  if (!progress) return [];
  const lines = progress
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("子代理 "));

  const out: string[] = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line);
  }
  return out;
}

export function summarizeSubagentProgressLines(lines: string[], maxLines = 14): string[] {
  return buildSubagentTraceView(lines, { maxLines }).lines;
}

function phaseForSubagentLine(line: string): { phase: SubagentTracePhaseKind; phaseLabel: string } {
  if (FAILURE_HINT_RE.test(line)) return { phase: "warning", phaseLabel: "异常" };
  if (/^子代理\s+\S+\s+开始/.test(line)) return { phase: "start", phaseLabel: "启动" };
  if (/^子代理\s+\S+\s+进度:/.test(line)) return { phase: "progress", phaseLabel: "进度" };
  if (/^子代理\s+\S+\s+调用/.test(line) || /^子代理\s+\S+\s+完成/.test(line)) return { phase: "tool", phaseLabel: "工具" };
  if (/^子代理\s+\S+\s+(结论|结束|完成任务)/.test(line)) return { phase: "final", phaseLabel: "收束" };
  return { phase: "event", phaseLabel: "事件" };
}

function prepareSubagentProgressLines(lines: string[]): PreparedSubagentLine[] {
  const prepared: PreparedSubagentLine[] = [];
  let pendingProgress: { prefix: string; last: string; count: number; indexStart: number; indexEnd: number; haystack: string[]; warning: boolean } | null = null;

  const flushProgress = () => {
    if (!pendingProgress) return;
    const label = pendingProgress.prefix.replace(/:$/, "");
    const text = pendingProgress.count > 1
      ? `${label} ×${pendingProgress.count}: ${pendingProgress.last}`
      : `${pendingProgress.prefix}${pendingProgress.last}`;
    prepared.push({
      text,
      indexStart: pendingProgress.indexStart,
      indexEnd: pendingProgress.indexEnd,
      phase: pendingProgress.warning ? "warning" : "progress",
      phaseLabel: pendingProgress.warning ? "异常" : "进度",
      haystack: normalizeTraceSearchText(`${text} ${pendingProgress.haystack.join(" ")}`),
    });
    pendingProgress = null;
  };

  lines.forEach((line, index) => {
    const progress = line.match(/^(子代理\s+\S+\s+进度:)(.*)$/);
    if (progress) {
      const prefix = progress[1] || "";
      const last = (progress[2] || "").trim();
      const warning = FAILURE_HINT_RE.test(line);
      if (pendingProgress !== null && pendingProgress.prefix === prefix) {
        pendingProgress = {
          prefix: pendingProgress.prefix,
          last,
          count: pendingProgress.count + 1,
          indexStart: pendingProgress.indexStart,
          indexEnd: index,
          haystack: [...pendingProgress.haystack, `#${index + 1} ${line}`],
          warning: pendingProgress.warning || warning,
        };
      } else {
        flushProgress();
        pendingProgress = { prefix, last, count: 1, indexStart: index, indexEnd: index, haystack: [`#${index + 1} ${line}`], warning };
      }
      return;
    }
    flushProgress();
    prepared.push({
      text: line,
      indexStart: index,
      indexEnd: index,
      ...phaseForSubagentLine(line),
      haystack: normalizeTraceSearchText(`#${index + 1} ${line}`),
    });
  });
  flushProgress();
  return prepared;
}

const FAILURE_HINT_RE = /失败|出错|错误|异常|超时|拒绝|failed|error|exception|traceback|timeout|denied|refused/i;

export function findSubagentTraceMarkers(lines: string[]): SubagentTraceMarker[] {
  const markers: SubagentTraceMarker[] = [];
  lines.forEach((line, index) => {
    if (!FAILURE_HINT_RE.test(line)) return;
    markers.push({
      index,
      kind: "warning",
      label: `#${index + 1} 异常`,
      detail: line,
      query: `#${index + 1}`,
    });
  });
  return markers;
}

export function buildSubagentTraceView(lines: string[], opts: SubagentTraceViewOptions = {}): SubagentTraceView {
  const allLines = prepareSubagentProgressLines(lines);
  const view = buildTraceWindow<PreparedSubagentLine, SubagentTraceLine, SubagentTracePhaseKind>(allLines, opts, {
    defaultMaxLines: 14,
    start: (line) => line.indexStart,
    end: (line) => line.indexEnd,
    toLine: toSubagentTraceLine,
    foldedLine: (hiddenLines): SubagentTraceLine => ({
      text: `… 已折叠前 ${hiddenLines} 条过程`,
      indexStart: -1,
      indexEnd: -1,
      phase: "event",
      phaseLabel: "折叠",
    }),
  });

  return {
    lines: view.lines,
    lineViews: view.lineViews,
    phaseGroups: view.phaseGroups.map((group) => ({
      phase: group.phase,
      phaseLabel: group.phaseLabel,
      count: group.count,
      indexStart: group.start,
      indexEnd: group.end,
    })),
    markers: findSubagentTraceMarkers(lines),
    totalLines: view.totalLines,
    matchCount: view.matchCount,
    hiddenLines: view.hiddenLines,
    hasQuery: view.hasQuery,
  };
}

function toSubagentTraceLine(line: PreparedSubagentLine): SubagentTraceLine {
  return {
    text: line.text,
    indexStart: line.indexStart,
    indexEnd: line.indexEnd,
    phase: line.phase,
    phaseLabel: line.phaseLabel,
  };
}

export function buildSubagentTrace(args?: Record<string, unknown>, progress?: string, result?: string): SubagentTrace | null {
  const parsed = parseAgentTaskResult(result);
  const lines = subagentProgressLines(progress);
  const agent = parsed?.agent || (typeof args?.agent === "string" ? args.agent : undefined);
  const agentId = parsed?.agentId;
  const task = typeof args?.task === "string" ? args.task : undefined;
  const finalText = parsed?.finalText;
  if (!agent && !agentId && !task && !finalText && lines.length === 0) return null;
  return {
    agent,
    ...(agentId ? { agentId } : {}),
    task,
    lines,
    finalText,
  };
}

export function parseBackgroundTaskStarted(result?: string): BackgroundTaskStarted | null {
  if (!result) return null;
  const match = result.match(/<background_task_started\b([^>]*)>\n?([\s\S]*?)\n?<\/background_task_started>/);
  if (!match) return null;
  return {
    id: attrFromTag(match[1] || "", "id"),
    agentId: attrFromTag(match[1] || "", "agent_id"),
    agent: attrFromTag(match[1] || "", "agent"),
    status: attrFromTag(match[1] || "", "status"),
    title: (match[2] || "").trim(),
  };
}
