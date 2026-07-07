import { describe, expect, test } from "vitest";
import { parseMcpResult, parseMcpTaskResult } from "./mcp-task-result";

describe("parseMcpTaskResult", () => {
  test("parses MCP task trace and result", () => {
    const parsed = parseMcpTaskResult(`<mcp_task_trace server="local fixture" tool="delay_echo">
<mcp_task event="created" id="task-1" status="running" pollInterval="10" />
<mcp_progress progress="1" total="3" message="queued" />
<mcp_task event="status" id="task-1" status="completed" message="done" />
</mcp_task_trace>
<mcp_result server="local fixture" tool="delay_echo">
task:slow hello
</mcp_result>`);

    expect(parsed).toEqual({
      server: "local fixture",
      tool: "delay_echo",
      isError: false,
      trace: [
        { kind: "task", event: "created", id: "task-1", status: "running", message: "" },
        { kind: "progress", progress: 1, total: 3, message: "queued" },
        { kind: "task", event: "status", id: "task-1", status: "completed", message: "done" },
      ],
      result: "task:slow hello",
    });
  });

  test("ignores ordinary MCP results", () => {
    expect(parseMcpTaskResult(`<mcp_result server="docs" tool="search">ok</mcp_result>`)).toBeNull();
  });

  test("parses ordinary MCP results", () => {
    expect(parseMcpResult(`<mcp_result server="docs" tool="search">
found &lt;thing&gt;
</mcp_result>`)).toEqual({
      server: "docs",
      tool: "search",
      isError: false,
      result: "found <thing>",
    });
  });

  test("parses stored ordinary MCP result preview", () => {
    expect(parseMcpResult(`<stored_tool_result tool="mcp__docs__search" call_id="call_1" chars="30000" bytes="32000" path="/tmp/result.txt">
<preview_head chars="80">
&lt;mcp_result server="docs" tool="search"&gt;
found
</preview_head>
<preview_tail chars="80">
thing
&lt;/mcp_result&gt;
</preview_tail>
</stored_tool_result>`)).toMatchObject({
      server: "docs",
      tool: "search",
      result: "found\nthing",
    });
  });
});
