import { describe, expect, test } from "vitest";
import { parseGrepRangesResult } from "./grep-ranges-result";

describe("parseGrepRangesResult", () => {
  test("parses grep ranges and read_many_files input", () => {
    const parsed = parseGrepRangesResult(`<grep_ranges matches="3" ranges="2" range_context="1">
<read_many_files_input>
{
  "ranges": [
    { "path": "src/a.ts", "start_line": 2, "end_line": 5 },
    { "path": "src/b.ts", "start_line": 1, "end_line": 3 }
  ]
}
</read_many_files_input>
<matched_lines>
src/a.ts:3,4
src/b.ts:2
</matched_lines>
…[已截断:匹配行达到 limit=3;请缩小 pattern/path/include]
</grep_ranges>`);

    expect(parsed).toEqual({
      matches: 3,
      ranges: 2,
      rangeContext: 1,
      readManyFilesInput: {
        ranges: [
          { path: "src/a.ts", start_line: 2, end_line: 5 },
          { path: "src/b.ts", start_line: 1, end_line: 3 },
        ],
      },
      matchedLines: ["src/a.ts:3,4", "src/b.ts:2"],
      notes: ["…[已截断:匹配行达到 limit=3;请缩小 pattern/path/include]"],
    });
  });

  test("ignores ordinary grep output", () => {
    expect(parseGrepRangesResult("src/a.ts:1:match")).toBeNull();
  });

  test("leaves missing numeric attributes undefined", () => {
    const parsed = parseGrepRangesResult(`<grep_ranges>
<read_many_files_input>
{ "ranges": [{ "path": "src/a.ts" }] }
</read_many_files_input>
</grep_ranges>`);

    expect(parsed?.matches).toBeUndefined();
    expect(parsed?.ranges).toBeUndefined();
    expect(parsed?.rangeContext).toBeUndefined();
  });
});
