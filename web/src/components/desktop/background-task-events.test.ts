import { describe, expect, test } from "vitest";

import {
  buildBackgroundTaskTraceView,
  findBackgroundTaskTraceMarkers,
  formatBackgroundTaskEventLine,
  formatBackgroundTaskEventLines,
} from "./background-task-events";

describe("formatBackgroundTaskEventLine", () => {
  test("formats tool calls with useful argument hints", () => {
    expect(formatBackgroundTaskEventLine({
      seq: 3,
      ts: "2026-07-07T00:00:00Z",
      event: { type: "tool_call", tool: "grep_files", input: { query: "approval_request", path: "ts/src" } },
    })).toBe("#3 调用 grep_files: ts/src");
  });

  test("formats final and progress events without dumping raw JSON", () => {
    expect(formatBackgroundTaskEventLine({
      seq: 9,
      ts: "2026-07-07T00:00:00Z",
      event: { type: "tool_progress", tool: "agent_task", chunk: "子代理 researcher 调用 read_file: a.ts\n" },
    })).toBe("#9 agent_task 进度: 子代理 researcher 调用 read_file: a.ts");
    expect(formatBackgroundTaskEventLine({
      seq: 12,
      ts: "2026-07-07T00:00:00Z",
      event: { type: "final", text: "完成" },
    })).toBe("#12 结论: 完成");
  });

  test("folds consecutive progress events and hides usage noise", () => {
    expect(formatBackgroundTaskEventLines([
      { seq: 1, ts: "", event: { type: "started" } },
      { seq: 2, ts: "", event: { type: "tool_progress", tool: "run_command", id: "a", chunk: "case 1\n" } },
      { seq: 3, ts: "", event: { type: "usage_update", total: 10 } },
      { seq: 4, ts: "", event: { type: "tool_progress", tool: "run_command", id: "a", chunk: "case 2\n" } },
      { seq: 5, ts: "", event: { type: "tool_result", tool: "run_command" } },
    ])).toEqual([
      "#1 已启动",
      "#2-#4 run_command 进度 ×2: case 2",
      "#5 run_command 完成",
    ]);
  });

  test("locates blocked, failed, and final trace markers", () => {
    expect(findBackgroundTaskTraceMarkers([
      { seq: 1, ts: "", event: { type: "started" } },
      { seq: 2, ts: "", event: { type: "approval_request", tool: "write_file" } },
      { seq: 3, ts: "", event: { type: "ask_question", question: "用哪个分支？" } },
      { seq: 4, ts: "", event: { type: "tool_result", tool: "run_command", output: "Error: test failed" } },
      { seq: 5, ts: "", event: { type: "error", error: "模型请求超时" } },
      { seq: 6, ts: "", event: { type: "final", text: "已停止" } },
    ])).toEqual([
      { seq: 2, kind: "blocked", label: "#2 待确认", detail: "write_file" },
      { seq: 3, kind: "blocked", label: "#3 需补充", detail: "用哪个分支？" },
      { seq: 4, kind: "warning", label: "#4 工具提醒", detail: "Error: test failed" },
      { seq: 5, kind: "error", label: "#5 出错", detail: "模型请求超时" },
      { seq: 6, kind: "final", label: "#6 结论", detail: "已停止" },
    ]);
  });

  test("filters trace lines by query after folding progress", () => {
    const trace = buildBackgroundTaskTraceView([
      { seq: 1, ts: "", event: { type: "started" } },
      { seq: 2, ts: "", event: { type: "tool_progress", tool: "run_command", id: "a", chunk: "case 1 failed\n" } },
      { seq: 3, ts: "", event: { type: "tool_progress", tool: "run_command", id: "a", chunk: "case 2 still running\n" } },
      { seq: 4, ts: "", event: { type: "tool_call", tool: "grep_files", input: { pattern: "provider", path: "ts/src" } } },
      { seq: 5, ts: "", event: { type: "final", text: "完成" } },
    ], { query: "case 1", maxLines: 80 });
    expect(trace.hasQuery).toBe(true);
    expect(trace.matchCount).toBe(1);
    expect(trace.lines).toEqual(["#2-#3 run_command 进度 ×2: case 2 still running"]);
    expect(buildBackgroundTaskTraceView([
      { seq: 4, ts: "", event: { type: "tool_call", tool: "grep_files", input: { pattern: "provider", path: "ts/src" } } },
    ], { query: "grep provider" }).lines).toEqual(["#4 调用 grep_files: ts/src"]);
  });

  test("adds phase metadata and adjacent phase groups without changing line text", () => {
    const trace = buildBackgroundTaskTraceView([
      { seq: 1, ts: "", event: { type: "started" } },
      { seq: 2, ts: "", event: { type: "thinking", text: "分析仓库" } },
      { seq: 3, ts: "", event: { type: "tool_call", tool: "grep_files", input: { pattern: "trace", path: "web/src" } } },
      { seq: 4, ts: "", event: { type: "tool_result", tool: "grep_files" } },
      { seq: 5, ts: "", event: { type: "approval_request", tool: "write_file" } },
      { seq: 6, ts: "", event: { type: "final", text: "完成" } },
    ]);

    expect(trace.lineViews.map((line) => [line.phaseLabel, line.text])).toEqual([
      ["启动", "#1 已启动"],
      ["思考", "#2 思考: 分析仓库"],
      ["工具", "#3 调用 grep_files: web/src"],
      ["工具", "#4 grep_files 完成"],
      ["确认", "#5 等待确认: write_file"],
      ["收束", "#6 结论: 完成"],
    ]);
    expect(trace.phaseGroups.map((group) => `${group.phaseLabel}:${group.count}`)).toEqual([
      "启动:1",
      "思考:1",
      "工具:2",
      "确认:1",
      "收束:1",
    ]);
    expect(trace.lines).toEqual(trace.lineViews.map((line) => line.text));
  });
});
