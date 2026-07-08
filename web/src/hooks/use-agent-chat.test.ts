import { describe, expect, test } from "vitest";

import { approvedToolResultMessage, fileArtifactFromToolResult, pendingFileArtifactFromToolCall } from "./approved-tool-result-message";
import { retryStatusText } from "./agent-retry-status";
import { agentUsageFromPayload, agentUsageStatusText, compactTokenCount } from "./agent-usage-status";

describe("approvedToolResultMessage", () => {
  test("creates a pending preview artifact as soon as a file mutation starts", () => {
    expect(pendingFileArtifactFromToolCall("edit_file", { path: "/tmp/demo.ts" })).toMatchObject({
      kind: "file_pending",
      path: "/tmp/demo.ts",
      tool: "edit_file",
    });
    expect(pendingFileArtifactFromToolCall("patch_files", { patches: [{ path: "/tmp/a.ts", patch: "@@" }, { path: "/tmp/b.ts", patch: "@@" }] })).toMatchObject({
      kind: "file_pending_list",
      paths: ["/tmp/a.ts", "/tmp/b.ts"],
      tool: "patch_files",
    });
    expect(pendingFileArtifactFromToolCall("restore_file", { path: "/tmp/demo.ts" })).toMatchObject({
      kind: "file_pending",
      title: "正在恢复文件",
      path: "/tmp/demo.ts",
      tool: "restore_file",
    });
    expect(pendingFileArtifactFromToolCall("edit_excel", { path: "/tmp/report.xlsx", cell: "B2", value: 9 })).toMatchObject({
      kind: "file_pending",
      title: "正在修改报表文件",
      path: "/tmp/report.xlsx",
      tool: "edit_excel",
    });
    expect(pendingFileArtifactFromToolCall("restore_file", { path: "/tmp/demo.ts", dry_run: true })).toBeNull();
    expect(pendingFileArtifactFromToolCall("read_file", { path: "/tmp/demo.ts" })).toBeNull();
  });

  test("creates a diff preview artifact from completed file mutation output", () => {
    const result = '<file_change path="/tmp/demo.ts" backup_path="/tmp/demo.ts.bak" />';
    expect(fileArtifactFromToolResult("edit_file", result, { path: "/fallback.ts" })).toMatchObject({
      kind: "diff",
      path: "/tmp/demo.ts",
      backupPath: "/tmp/demo.ts.bak",
    });

    const multi = [
      '<file_changes count="2">',
      '<file_change path="/tmp/a.ts" backup_path="/tmp/a.ts.bak" />',
      '<file_change path="/tmp/b.ts" backup_path="/tmp/b.ts.bak" />',
      '</file_changes>',
    ].join("\n");
    expect(fileArtifactFromToolResult("patch_files", multi, { patches: [] })).toMatchObject({
      kind: "diff_list",
      changes: [
        { path: "/tmp/a.ts", backupPath: "/tmp/a.ts.bak" },
        { path: "/tmp/b.ts", backupPath: "/tmp/b.ts.bak" },
      ],
    });

    expect(fileArtifactFromToolResult("restore_file", '<restore_file snapshot_id="s1" path="/tmp/demo.ts" backup_path="/tmp/demo.ts.before-restore">diff</restore_file>', { path: "/tmp/demo.ts" })).toMatchObject({
      kind: "diff",
      title: "文件恢复对比",
      path: "/tmp/demo.ts",
      backupPath: "/tmp/demo.ts.before-restore",
    });
    expect(fileArtifactFromToolResult("edit_excel", '<file_change path="/tmp/report.xlsx" backup_path="/tmp/report.xlsx.bak" />', { path: "/fallback.xlsx" })).toMatchObject({
      kind: "diff",
      path: "/tmp/report.xlsx",
      backupPath: "/tmp/report.xlsx.bak",
    });
    expect(fileArtifactFromToolResult("restore_file", '<restore_preview snapshot_id="s1" path="/tmp/demo.ts">diff</restore_preview>', { path: "/tmp/demo.ts", dry_run: true })).toBeNull();
  });

  test("parses file_change path without confusing backup_path when attributes are reordered", () => {
    const result = '<file_change backup_path="/tmp/demo.ts.bak" path="/tmp/demo.ts" />';
    expect(fileArtifactFromToolResult("edit_file", result, { path: "/fallback.ts" })).toMatchObject({
      kind: "diff",
      path: "/tmp/demo.ts",
      backupPath: "/tmp/demo.ts.bak",
    });
  });

  test("replaces pending file preview with an error artifact when mutation fails", () => {
    expect(fileArtifactFromToolResult("write_file", "错误:工具 write_file 执行失败:目标目录存在项目指令", { path: "/tmp/new.ts" })).toMatchObject({
      kind: "file_error",
      path: "/tmp/new.ts",
      tool: "write_file",
      message: "工具 write_file 执行失败:目标目录存在项目指令",
    });
    expect(fileArtifactFromToolResult("patch_files", "错误:patch_files 第 2 个文件上下文不匹配", { patches: [{ path: "/tmp/a.ts", patch: "@@" }] })).toMatchObject({
      kind: "file_error",
      path: "/tmp/a.ts",
      tool: "patch_files",
    });
    expect(fileArtifactFromToolResult("patch_files", "错误:patch_files 第 2 个文件上下文不匹配", {
      patches: [
        { path: "/tmp/a.ts", patch: "@@" },
        { path: "/tmp/b.ts", patch: "@@" },
      ],
    })).toMatchObject({
      kind: "file_error_list",
      paths: ["/tmp/a.ts", "/tmp/b.ts"],
      tool: "patch_files",
      message: "patch_files 第 2 个文件上下文不匹配",
    });
    expect(fileArtifactFromToolResult("restore_file", "错误:restore_file 没有找到历史快照", { path: "/tmp/demo.ts" })).toMatchObject({
      kind: "file_error",
      title: "文件未恢复",
      path: "/tmp/demo.ts",
      tool: "restore_file",
      message: "restore_file 没有找到历史快照",
    });
  });

  test("keeps approved file mutations as previewable tool steps", () => {
    const result = '<file_change path="/tmp/demo.ts" backup_path="/tmp/demo.ts.bak" />';
    const msg = approvedToolResultMessage("edit_file", { path: "/tmp/demo.ts" }, result);

    expect(msg).toMatchObject({
      role: "assistant",
      content: "",
      steps: [
        {
          tool: "edit_file",
          args: { path: "/tmp/demo.ts" },
          result,
          done: true,
        },
      ],
    });
  });

  test("keeps approved command results on their specialized render path", () => {
    expect(approvedToolResultMessage("run_command", { command: "bun test" }, "ok")).toMatchObject({
      kind: "command",
      content: "ok",
    });
  });

  test("renders approved oversized tool results as tool steps instead of raw command text", () => {
    const result = [
      '<stored_tool_result tool="run_command" call_id="approved" chars="30000" bytes="30000" path="/tmp/result.txt">',
      '<preview_head chars="4">HEAD</preview_head>',
      '<preview_tail chars="4">TAIL</preview_tail>',
      '</stored_tool_result>',
    ].join("\n");

    expect(approvedToolResultMessage("run_command", { command: "bun test" }, result)).toMatchObject({
      role: "assistant",
      content: "",
      steps: [
        {
          tool: "run_command",
          args: { command: "bun test" },
          result,
          done: true,
        },
      ],
    });
  });
});

describe("retryStatusText", () => {
  test("shows visible reconnect attempt and delay", () => {
    expect(retryStatusText({ phase: "waiting", attempt: 2, maxAttempts: 5, delayMs: 2500 })).toBe("连接断开，3 秒后重连（第 2/5 次）");
    expect(retryStatusText({ phase: "retrying", attempt: 2, maxAttempts: 5 })).toBe("正在重连（第 2/5 次）");
  });
});

describe("agentUsageStatusText", () => {
  test("formats context pressure, turn usage and cache usage", () => {
    const usage = agentUsageFromPayload({
      input_tokens: 12_400,
      output_tokens: 1800,
      total_tokens: 14_200,
      last_input_tokens: 7200,
      last_output_tokens: 800,
      cache_read_input_tokens: 2400,
      context_window: 100_000,
      context_percent: 7.2,
    });

    expect(agentUsageStatusText(usage)).toBe("≈7.2% · 本轮 14k · 最新 8.0k · 缓存 2.4k");
  });

  test("falls back to token counts when context window is unknown", () => {
    expect(compactTokenCount(1_250_000)).toBe("1.3m");
    expect(agentUsageStatusText({
      inputTokens: 800,
      outputTokens: 120,
      totalTokens: 920,
      lastInputTokens: 800,
      lastOutputTokens: 120,
    })).toBe("本轮 920 · 最新 920");
  });
});
