import { describe, expect, test } from "vitest";
import { parseFileHistoryResult } from "./file-history-result";

describe("parseFileHistoryResult", () => {
  test("parses file snapshot lines and optional diffs", () => {
    const parsed = parseFileHistoryResult([
      "- id:s2 path:src/app.ts op:edit_file seq:2 prev:s1 time:2026-07-07T00:00:02.000Z size:12",
      "<snapshot_diff id=\"s2\" path=\"src/app.ts\">",
      "@@ -1,1 +1,1 @@",
      "-after",
      "+before",
      "</snapshot_diff>",
      "- id:s1 path:src/new file.ts op:write_file seq:1 time:2026-07-07T00:00:01.000Z before:missing skipped:not a regular file",
    ].join("\n"));

    expect(parsed).toMatchObject({
      status: "found",
      snapshots: [
        {
          id: "s2",
          path: "src/app.ts",
          operation: "edit_file",
          sequence: 2,
          previousId: "s1",
          size: 12,
          diff: expect.stringContaining("-after"),
        },
        {
          id: "s1",
          path: "src/new file.ts",
          beforeMissing: true,
          skippedReason: "not a regular file",
        },
      ],
    });
  });

  test("parses empty history and ignores plain text", () => {
    expect(parseFileHistoryResult("没有文件历史快照。")).toEqual({ status: "empty", snapshots: [] });
    expect(parseFileHistoryResult("plain text")).toBeNull();
  });

  test("parses stored file history previews", () => {
    const parsed = parseFileHistoryResult(`<stored_tool_result tool="file_history" call_id="c1" chars="40000" bytes="42000" path="/tmp/history.txt">
<preview_head chars="120">
- id:s1 path:src/a.ts op:edit_file seq:1 time:2026-07-07T00:00:01.000Z size:12
</preview_head>
<preview_tail chars="120">
- id:s2 path:src/b.ts op:patch_file seq:2 prev:s1 time:2026-07-07T00:00:02.000Z before:missing
</preview_tail>
</stored_tool_result>`);

    expect(parsed).toMatchObject({
      status: "stored",
      stored: {
        path: "/tmp/history.txt",
        chars: 40000,
        bytes: 42000,
      },
      snapshots: [
        { id: "s1", path: "src/a.ts" },
        { id: "s2", path: "src/b.ts", beforeMissing: true },
      ],
    });
  });
});
