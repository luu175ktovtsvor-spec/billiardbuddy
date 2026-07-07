import { describe, expect, test } from "vitest";

import {
  buildSubagentTrace,
  buildSubagentTraceView,
  findSubagentTraceMarkers,
  parseAgentTaskResult,
  parseBackgroundTaskStarted,
  subagentProgressLines,
  summarizeSubagentProgressLines,
} from "./subagent-trace";

describe("subagent trace helpers", () => {
  test("parses agent_task result without exposing XML tags", () => {
    expect(parseAgentTaskResult('<agent_task agent="researcher" agent_id="agent_1">\n结论 **A**\n</agent_task>')).toEqual({
      agent: "researcher",
      agentId: "agent_1",
      finalText: "结论 **A**",
    });
  });

  test("keeps only subagent progress lines and removes adjacent duplicates", () => {
    expect(subagentProgressLines([
      "noise",
      "子代理 researcher 开始:读文件",
      "子代理 researcher 开始:读文件",
      "子代理 researcher 调用 read_file: a.ts",
      "",
    ].join("\n"))).toEqual([
      "子代理 researcher 开始:读文件",
      "子代理 researcher 调用 read_file: a.ts",
    ]);
  });

  test("combines args, progress and final result", () => {
    const trace = buildSubagentTrace(
      { task: "扫描授权逻辑" },
      "子代理 security 调用 grep_files: auth\n",
      '<agent_task agent="security" agent_id="agent_security_1">\n没有发现高危问题\n</agent_task>',
    );
    expect(trace).toEqual({
      agent: "security",
      agentId: "agent_security_1",
      task: "扫描授权逻辑",
      lines: ["子代理 security 调用 grep_files: auth"],
      finalText: "没有发现高危问题",
    });
  });

  test("folds consecutive progress noise but keeps structural lines", () => {
    expect(summarizeSubagentProgressLines([
      "子代理 researcher 开始:跑测试",
      "子代理 researcher 进度:case 1",
      "子代理 researcher 进度:case 2",
      "子代理 researcher 完成 run_command",
    ])).toEqual([
      "子代理 researcher 开始:跑测试",
      "子代理 researcher 进度 ×2: case 2",
      "子代理 researcher 完成 run_command",
    ]);
  });

  test("builds searchable trace view and keeps folded progress searchable", () => {
    const view = buildSubagentTraceView([
      "子代理 researcher 开始:跑测试",
      "子代理 researcher 进度:case 1 failed",
      "子代理 researcher 进度:case 2 still running",
      "子代理 researcher 完成 run_command",
    ], { query: "case 1" });
    expect(view.hasQuery).toBe(true);
    expect(view.matchCount).toBe(1);
    expect(view.lines).toEqual(["子代理 researcher 进度 ×2: case 2 still running"]);
    expect(findSubagentTraceMarkers([
      "子代理 researcher 进度:case 1 failed",
      "子代理 researcher 完成 run_command",
    ])).toEqual([
      {
        index: 0,
        kind: "warning",
        label: "#1 异常",
        detail: "子代理 researcher 进度:case 1 failed",
        query: "#1",
      },
    ]);
  });

  test("adds phase metadata and phase groups to folded subagent traces", () => {
    const view = buildSubagentTraceView([
      "子代理 researcher 开始:跑测试",
      "子代理 researcher 调用 grep_files: trace",
      "子代理 researcher 完成 grep_files",
      "子代理 researcher 进度:case 1 failed",
      "子代理 researcher 进度:case 2 still running",
      "子代理 researcher 结论:需要修复",
    ]);

    expect(view.lineViews.map((line) => [line.phaseLabel, line.text])).toEqual([
      ["启动", "子代理 researcher 开始:跑测试"],
      ["工具", "子代理 researcher 调用 grep_files: trace"],
      ["工具", "子代理 researcher 完成 grep_files"],
      ["异常", "子代理 researcher 进度 ×2: case 2 still running"],
      ["收束", "子代理 researcher 结论:需要修复"],
    ]);
    expect(view.phaseGroups.map((group) => `${group.phaseLabel}:${group.count}`)).toEqual([
      "启动:1",
      "工具:2",
      "异常:1",
      "收束:1",
    ]);
    expect(view.lines).toEqual(view.lineViews.map((line) => line.text));
  });

  test("parses background task started marker", () => {
    expect(parseBackgroundTaskStarted('<background_task_started id="task_1" agent_id="agent_1" agent="researcher" status="queued">\n后台分析\n</background_task_started>')).toEqual({
      id: "task_1",
      agentId: "agent_1",
      agent: "researcher",
      status: "queued",
      title: "后台分析",
    });
  });
});
