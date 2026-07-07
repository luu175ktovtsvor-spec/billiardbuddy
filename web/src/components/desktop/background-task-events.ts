import { buildTraceWindow, normalizeTraceSearchText } from "./trace-view";

export interface BackgroundTaskEventRecord {
  seq: number;
  ts: string;
  event: Record<string, unknown>;
}

export interface BackgroundTaskEventLineOptions {
  maxLines?: number;
}

export type BackgroundTaskTraceMarkerKind = "error" | "warning" | "blocked" | "final";

export interface BackgroundTaskTraceMarker {
  seq: number;
  kind: BackgroundTaskTraceMarkerKind;
  label: string;
  detail: string;
}

export type BackgroundTaskTracePhaseKind = "start" | "thinking" | "tool" | "progress" | "blocked" | "notice" | "final" | "error";

export interface BackgroundTaskTraceLine {
  text: string;
  seqStart: number;
  seqEnd: number;
  phase: BackgroundTaskTracePhaseKind;
  phaseLabel: string;
}

export interface BackgroundTaskTracePhaseGroup {
  phase: BackgroundTaskTracePhaseKind;
  phaseLabel: string;
  count: number;
  seqStart: number;
  seqEnd: number;
}

export interface BackgroundTaskTraceViewOptions extends BackgroundTaskEventLineOptions {
  query?: string;
}

export interface BackgroundTaskTraceView {
  lines: string[];
  lineViews: BackgroundTaskTraceLine[];
  phaseGroups: BackgroundTaskTracePhaseGroup[];
  markers: BackgroundTaskTraceMarker[];
  totalLines: number;
  matchCount: number;
  hiddenLines: number;
  hasQuery: boolean;
}

interface PreparedEventLine {
  text: string;
  seqStart: number;
  seqEnd: number;
  phase: BackgroundTaskTracePhaseKind;
  phaseLabel: string;
  haystack: string;
}

function oneLine(value: unknown, max = 180): string {
  const text = typeof value === "string"
    ? value
    : value === undefined || value === null ? "" : JSON.stringify(value);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function argHint(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "query", "pattern", "command", "name", "url", "task"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 80);
  }
  return oneLine(input, 80);
}

export function formatBackgroundTaskEventLine(record: BackgroundTaskEventRecord): string {
  const event = record.event || {};
  const type = typeof event.type === "string" ? event.type : "event";
  const prefix = `#${record.seq}`;
  if (type === "started") return `${prefix} 已启动`;
  if (type === "thinking") return `${prefix} 思考: ${oneLine(event.text)}`;
  if (type === "tool_call") {
    const tool = typeof event.tool === "string" ? event.tool : "tool";
    const hint = argHint(event.input);
    return `${prefix} 调用 ${tool}${hint ? `: ${hint}` : ""}`;
  }
  if (type === "tool_progress") {
    const tool = typeof event.tool === "string" ? event.tool : "tool";
    return `${prefix} ${tool} 进度: ${oneLine(event.chunk)}`;
  }
  if (type === "tool_result") {
    const tool = typeof event.tool === "string" ? event.tool : "tool";
    return `${prefix} ${tool} 完成`;
  }
  if (type === "todo_update") return `${prefix} 更新任务清单`;
  if (type === "context_note") return `${prefix} 提醒: ${oneLine(event.text)}`;
  if (type === "approval_request") {
    const tool = typeof event.tool === "string" ? event.tool : "动作";
    return `${prefix} 等待确认: ${tool}`;
  }
  if (type === "ask_question") return `${prefix} 需要补充: ${oneLine(event.question)}`;
  if (type === "final") return `${prefix} 结论: ${oneLine(event.text)}`;
  if (type === "done") return `${prefix} 已结束`;
  if (type === "error") return `${prefix} 出错: ${oneLine(event.error)}`;
  if (type === "usage_update") return `${prefix} 更新用量`;
  return `${prefix} ${type}: ${oneLine(event)}`;
}

function eventType(record: BackgroundTaskEventRecord): string {
  return typeof record.event?.type === "string" ? record.event.type : "event";
}

function toolName(record: BackgroundTaskEventRecord): string {
  return typeof record.event?.tool === "string" ? record.event.tool : "";
}

function progressKey(record: BackgroundTaskEventRecord): string {
  const event = record.event || {};
  const tool = typeof event.tool === "string" ? event.tool : "tool";
  const id = typeof event.id === "string" ? event.id : "";
  const stream = typeof event.stream === "string" ? event.stream : "";
  return `${tool}\u0000${id}\u0000${stream}`;
}

function phaseForEventType(type: string): { phase: BackgroundTaskTracePhaseKind; phaseLabel: string } {
  if (type === "started") return { phase: "start", phaseLabel: "启动" };
  if (type === "thinking") return { phase: "thinking", phaseLabel: "思考" };
  if (type === "tool_progress") return { phase: "progress", phaseLabel: "进度" };
  if (type === "tool_call" || type === "tool_result" || type === "todo_update") return { phase: "tool", phaseLabel: "工具" };
  if (type === "approval_request") return { phase: "blocked", phaseLabel: "确认" };
  if (type === "ask_question") return { phase: "blocked", phaseLabel: "补充" };
  if (type === "context_note") return { phase: "notice", phaseLabel: "提醒" };
  if (type === "final" || type === "done") return { phase: "final", phaseLabel: "收束" };
  if (type === "error") return { phase: "error", phaseLabel: "错误" };
  return { phase: "notice", phaseLabel: "事件" };
}

function foldedProgressLine(records: BackgroundTaskEventRecord[]): string {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const event = last.event || {};
  const tool = typeof event.tool === "string" ? event.tool : "tool";
  const label = first.seq === last.seq ? `#${first.seq}` : `#${first.seq}-#${last.seq}`;
  return `${label} ${tool} 进度 ×${records.length}: ${oneLine(event.chunk)}`;
}

function preparedLine(record: BackgroundTaskEventRecord): PreparedEventLine {
  const text = formatBackgroundTaskEventLine(record);
  const phase = phaseForEventType(eventType(record));
  return {
    text,
    seqStart: record.seq,
    seqEnd: record.seq,
    ...phase,
    haystack: normalizeTraceSearchText(`${text} #${record.seq} ${eventType(record)} ${toolName(record)} ${phase.phaseLabel} ${oneLine(record.event, 500)}`),
  };
}

function preparedProgressLine(records: BackgroundTaskEventRecord[]): PreparedEventLine {
  if (records.length === 1) return preparedLine(records[0]!);
  const first = records[0]!;
  const last = records[records.length - 1]!;
  const text = foldedProgressLine(records);
  const seqIndex = records.map((record) => `#${record.seq}`).join(" ");
  return {
    text,
    seqStart: first.seq,
    seqEnd: last.seq,
    phase: "progress",
    phaseLabel: "进度",
    haystack: normalizeTraceSearchText(`${text} ${seqIndex} tool_progress ${toolName(last)} 进度 ${records.map((record) => oneLine(record.event, 500)).join(" ")}`),
  };
}

function prepareBackgroundTaskEventLines(records: BackgroundTaskEventRecord[]): PreparedEventLine[] {
  const lines: PreparedEventLine[] = [];
  let pendingProgress: BackgroundTaskEventRecord[] = [];
  let pendingProgressKey = "";

  const flushProgress = () => {
    if (!pendingProgress.length) return;
    lines.push(preparedProgressLine(pendingProgress));
    pendingProgress = [];
    pendingProgressKey = "";
  };

  for (const record of records) {
    const type = eventType(record);
    if (type === "usage_update") continue;
    if (type === "tool_progress") {
      const key = progressKey(record);
      if (pendingProgress.length && key === pendingProgressKey) {
        pendingProgress.push(record);
      } else {
        flushProgress();
        pendingProgress = [record];
        pendingProgressKey = key;
      }
      continue;
    }
    flushProgress();
    lines.push(preparedLine(record));
  }
  flushProgress();

  return lines;
}

const FAILURE_HINT_RE = /失败|出错|错误|异常|超时|拒绝|failed|error|exception|traceback|timeout|denied|refused/i;

export function findBackgroundTaskTraceMarkers(records: BackgroundTaskEventRecord[]): BackgroundTaskTraceMarker[] {
  const markers: BackgroundTaskTraceMarker[] = [];
  for (const record of records) {
    const type = eventType(record);
    const event = record.event || {};
    if (type === "error") {
      markers.push({ seq: record.seq, kind: "error", label: `#${record.seq} 出错`, detail: oneLine(event.error || event.message || event, 90) });
    } else if (type === "approval_request") {
      const tool = typeof event.tool === "string" ? event.tool : "动作";
      markers.push({ seq: record.seq, kind: "blocked", label: `#${record.seq} 待确认`, detail: tool });
    } else if (type === "ask_question") {
      markers.push({ seq: record.seq, kind: "blocked", label: `#${record.seq} 需补充`, detail: oneLine(event.question, 90) });
    } else if (type === "final") {
      markers.push({ seq: record.seq, kind: "final", label: `#${record.seq} 结论`, detail: oneLine(event.text, 90) });
    } else if (type === "context_note" && FAILURE_HINT_RE.test(oneLine(event.text))) {
      markers.push({ seq: record.seq, kind: "warning", label: `#${record.seq} 提醒`, detail: oneLine(event.text, 90) });
    } else if (type === "tool_result" && FAILURE_HINT_RE.test(oneLine(event.output))) {
      markers.push({ seq: record.seq, kind: "warning", label: `#${record.seq} 工具提醒`, detail: oneLine(event.output, 90) });
    } else if (type === "tool_progress" && FAILURE_HINT_RE.test(oneLine(event.chunk))) {
      markers.push({ seq: record.seq, kind: "warning", label: `#${record.seq} 进度异常`, detail: oneLine(event.chunk, 90) });
    }
  }
  return markers;
}

export function buildBackgroundTaskTraceView(
  records: BackgroundTaskEventRecord[],
  opts: BackgroundTaskTraceViewOptions = {},
): BackgroundTaskTraceView {
  const allLines = prepareBackgroundTaskEventLines(records);
  const view = buildTraceWindow<PreparedEventLine, BackgroundTaskTraceLine, BackgroundTaskTracePhaseKind>(allLines, opts, {
    defaultMaxLines: 120,
    start: (line) => line.seqStart,
    end: (line) => line.seqEnd,
    toLine: toTraceLine,
    foldedLine: (hiddenLines): BackgroundTaskTraceLine => ({
      text: `… 已折叠前 ${hiddenLines} 条过程`,
      seqStart: 0,
      seqEnd: 0,
      phase: "notice",
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
      seqStart: group.start,
      seqEnd: group.end,
    })),
    markers: findBackgroundTaskTraceMarkers(records),
    totalLines: view.totalLines,
    matchCount: view.matchCount,
    hiddenLines: view.hiddenLines,
    hasQuery: view.hasQuery,
  };
}

function toTraceLine(line: PreparedEventLine): BackgroundTaskTraceLine {
  return {
    text: line.text,
    seqStart: line.seqStart,
    seqEnd: line.seqEnd,
    phase: line.phase,
    phaseLabel: line.phaseLabel,
  };
}

export function formatBackgroundTaskEventLines(
  records: BackgroundTaskEventRecord[],
  opts: BackgroundTaskEventLineOptions = {},
): string[] {
  return buildBackgroundTaskTraceView(records, opts).lines;
}
