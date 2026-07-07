import { describe, expect, test } from "vitest";
import { parseCodeOutlineRangesResult } from "./code-outline-ranges-result";

describe("parseCodeOutlineRangesResult", () => {
  test("parses code outline ranges and symbol lines", () => {
    const parsed = parseCodeOutlineRangesResult(`<code_outline files="1" range_context="1">
<file path="src/app.ts" size="120" bytes="120">
<symbols>
2:class:Runner export class Runner {
7:function:main:export export function main() {
</symbols>
</file>
<read_many_files_input>
{
  "ranges": [
    { "path": "src/app.ts", "start_line": 1, "end_line": 4 },
    { "path": "src/app.ts", "start_line": 6, "end_line": 8 }
  ]
}
</read_many_files_input>
<symbol_lines>
src/app.ts:2:Runner
src/app.ts:7:main
</symbol_lines>
</code_outline>`);

    expect(parsed).toEqual({
      files: 1,
      omitted: undefined,
      rangeContext: 1,
      readManyFilesInput: {
        ranges: [
          { path: "src/app.ts", start_line: 1, end_line: 4 },
          { path: "src/app.ts", start_line: 6, end_line: 8 },
        ],
      },
      symbolLines: ["src/app.ts:2:Runner", "src/app.ts:7:main"],
    });
  });

  test("ignores code outline without ranges", () => {
    expect(parseCodeOutlineRangesResult(`<code_outline files="1">
<file path="src/app.ts" size="120" bytes="120"></file>
</code_outline>`)).toBeNull();
  });
});
