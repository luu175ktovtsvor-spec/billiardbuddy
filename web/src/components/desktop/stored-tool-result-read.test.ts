import { describe, expect, test } from "vitest";

import { parseStoredToolResultRead } from "./stored-tool-result-read";

describe("parseStoredToolResultRead", () => {
  test("parses a completed stored result window", () => {
    const parsed = parseStoredToolResultRead(`<stored_tool_result_read status="completed" agent_id="agent_1" path="/tmp/result.txt" size="1000" offset="900" bytes="100" limit="120" truncated_top="true" truncated_bottom="false">
tail &lt;ok&gt;
</stored_tool_result_read>`);

    expect(parsed).toEqual({
      status: "completed",
      agentId: "agent_1",
      path: "/tmp/result.txt",
      size: 1000,
      offset: 900,
      bytes: 100,
      limit: 120,
      truncatedTop: true,
      truncatedBottom: false,
      content: "tail <ok>",
    });
  });

  test("parses rejected or missing states", () => {
    expect(parseStoredToolResultRead(`<stored_tool_result_read status="rejected" path="/tmp/outside.txt">
只能读取当前会话工具结果目录里的文件。
</stored_tool_result_read>`)).toMatchObject({
      status: "rejected",
      path: "/tmp/outside.txt",
      content: "只能读取当前会话工具结果目录里的文件。",
    });
  });

  test("ignores ordinary output", () => {
    expect(parseStoredToolResultRead("plain text")).toBeNull();
  });
});
