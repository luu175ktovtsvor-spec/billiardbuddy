import { describe, expect, test } from "vitest";
import { parseRestoreFileResult } from "./restore-file-result";

describe("parseRestoreFileResult", () => {
  test("parses restore preview diff", () => {
    expect(parseRestoreFileResult(`<restore_preview snapshot_id="s1" path="src/app.ts">
@@ -1,1 +1,1 @@
-after
+before
</restore_preview>`)).toEqual({
      status: "preview",
      snapshotId: "s1",
      path: "src/app.ts",
      diff: "@@ -1,1 +1,1 @@\n-after\n+before",
    });
  });

  test("parses completed restore and ignores plain text", () => {
    expect(parseRestoreFileResult(`<restore_file snapshot_id="s2" path="src/app.ts">
无文件差异
</restore_file>`)).toMatchObject({
      status: "restored",
      snapshotId: "s2",
      path: "src/app.ts",
      diff: "无文件差异",
    });
    expect(parseRestoreFileResult("plain text")).toBeNull();
  });

  test("parses stored restore previews", () => {
    const parsed = parseRestoreFileResult(`<stored_tool_result tool="restore_file" call_id="c1" chars="50000" bytes="52000" path="/tmp/restore.txt">
<preview_head chars="100">
<restore_file snapshot_id="s3" path="src/app.ts">
@@ -1,1 +1,1 @@
-after
</preview_head>
<preview_tail chars="100">
+before
</restore_file>
</preview_tail>
</stored_tool_result>`);

    expect(parsed).toMatchObject({
      status: "stored",
      stored: {
        resultPath: "/tmp/restore.txt",
        chars: 50000,
        bytes: 52000,
      },
    });
    expect(parsed?.diff).toContain("+before");
  });
});
