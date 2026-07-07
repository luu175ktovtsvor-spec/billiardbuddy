import { describe, expect, test } from "vitest";

import { toolActionText } from "./agent-tools";

describe("toolActionText", () => {
  test("uses running and completed wording for common tools", () => {
    expect(toolActionText("read_file", "running")).toBe("正在读文件");
    expect(toolActionText("read_file", "done")).toBe("已读文件");
    expect(toolActionText("search_store_docs", "done")).toBe("已查店铺资料");
    expect(toolActionText("list_project_instructions", "done")).toBe("已查项目规则");
    expect(toolActionText("grep_files", "done", 3)).toBe("已搜索代码 ×3");
    expect(toolActionText("git_status", "done")).toBe("已查看 Git 改动");
    expect(toolActionText("git_history", "done")).toBe("已查看 Git 历史");
    expect(toolActionText("read_stored_tool_result", "done")).toBe("已读取长工具结果");
    expect(toolActionText("read_agent_task_stored_result", "done")).toBe("已读取子代理长结果");
    expect(toolActionText("SendUserMessage", "done")).toBe("已发送用户消息");
    expect(toolActionText("Brief", "running")).toBe("正在发送用户消息");
    expect(toolActionText("project_diagnostics", "done")).toBe("已跑项目诊断");
    expect(toolActionText("task_create", "done")).toBe("已创建任务");
    expect(toolActionText("TaskCreate", "running")).toBe("正在创建任务");
    expect(toolActionText("TaskUpdate", "done")).toBe("已更新任务");
    expect(toolActionText("TaskOutput", "done")).toBe("已读取任务输出");
    expect(toolActionText("AgentOutputTool", "done")).toBe("已读取代理输出");
    expect(toolActionText("BashOutputTool", "running")).toBe("正在读取命令输出");
    expect(toolActionText("agent_task", "running")).toBe("正在分派子代理");
    expect(toolActionText("patch_files", "running")).toBe("正在应用多文件补丁");
  });

  test("keeps opaque and MCP tool names readable", () => {
    expect(toolActionText("unknown_tool", "running")).toBe("正在调用 unknown_tool");
    expect(toolActionText("mcp__docs__search", "done")).toBe("已调用 MCP·docs·search");
  });
});
