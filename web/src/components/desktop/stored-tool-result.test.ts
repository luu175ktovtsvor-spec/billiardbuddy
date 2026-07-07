import { describe, expect, test } from "vitest";

import { parseStoredToolResult } from "./stored-tool-result";

describe("parseStoredToolResult", () => {
  test("parses stored result metadata and previews", () => {
    const parsed = parseStoredToolResult(`<stored_tool_result tool="grep_files" call_id="call_1" chars="30000" bytes="32000" path="/tmp/result.txt">
工具结果过长,已写入 path;模型上下文仅保留头尾预览。
<preview_head chars="12">
head &amp; value
</preview_head>
<preview_tail chars="9">
tail &lt;x&gt;
</preview_tail>
</stored_tool_result>`);

    expect(parsed).toEqual({
      tool: "grep_files",
      callId: "call_1",
      chars: 30000,
      bytes: 32000,
      path: "/tmp/result.txt",
      storageError: undefined,
      previewHead: "head & value",
      previewTail: "tail <x>",
    });
  });

  test("parses storage failure metadata", () => {
    const parsed = parseStoredToolResult('<stored_tool_result tool="run_command" call_id="c" chars="10" bytes="10" storage_error="no space"><preview_head chars="1">a</preview_head><preview_tail chars="1">b</preview_tail></stored_tool_result>');
    expect(parsed).toMatchObject({
      tool: "run_command",
      storageError: "no space",
      previewHead: "a",
      previewTail: "b",
    });
  });

  test("ignores ordinary output", () => {
    expect(parseStoredToolResult("plain text")).toBeNull();
  });
});
