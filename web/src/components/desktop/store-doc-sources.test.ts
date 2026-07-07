import { describe, expect, test } from "vitest";

import { parseStoreDocSources } from "./store-doc-sources";

describe("parseStoreDocSources", () => {
  test("prefers structured JSON source blocks when present", () => {
    const parsed = parseStoreDocSources(`<store_doc_sources>
[S1] 旧格式.md · 片段 1 · 可信度:low · 分数:1
匹配:旧
原因:旧原因
摘录:旧摘录
路径:/old.md
</store_doc_sources>

<store_doc_sources_json>
{"hits":[{"source_id":"S1","file_name":"价目表.md","chunk_index":1,"confidence":"high","score":18.25,"matched_terms":["台费","黄金档"],"why":"命中完整查询短语","excerpt":"黄金档台费每小时 68 元","path":"/Users/swl/store/价目表.md"}]}
</store_doc_sources_json>`);

    expect(parsed?.hits).toHaveLength(1);
    expect(parsed?.hits[0]).toMatchObject({
      sourceId: "S1",
      fileName: "价目表.md",
      chunkLabel: "片段 2",
      confidence: "high",
      score: "18.25",
      matchedTerms: ["台费", "黄金档"],
      excerpt: "黄金档台费每小时 68 元",
      path: "/Users/swl/store/价目表.md",
    });
  });

  test("parses sourced store document tool output", () => {
    const parsed = parseStoreDocSources(`<store_doc_sources>
回答时优先引用这些店铺文件来源。

[S1] 价目表.md · 片段 2 · 可信度:high · 分数:18.25
匹配:台费、黄金档
原因:命中完整查询短语；文件名命中查询
摘录:…黄金档台费每小时 68 元，会员可享 8 折…
路径:/Users/swl/store/价目表.md

[S2] 排班.xlsx · 片段 1 · 可信度:medium · 分数:6.5
匹配:无
原因:语义扩展命中:晚高峰
摘录:晚班 18:00-02:00
路径:/Users/swl/store/排班.xlsx
</store_doc_sources>`);

    expect(parsed?.hits).toHaveLength(2);
    expect(parsed?.hits[0]).toMatchObject({
      sourceId: "S1",
      fileName: "价目表.md",
      chunkLabel: "片段 2",
      confidence: "high",
      score: "18.25",
      matchedTerms: ["台费", "黄金档"],
      path: "/Users/swl/store/价目表.md",
    });
    expect(parsed?.hits[1]?.matchedTerms).toEqual([]);
  });

  test("ignores normal tool output and empty source blocks", () => {
    expect(parseStoreDocSources("没有在店铺资料库里找到相关内容。")).toBeNull();
    expect(parseStoreDocSources("<store_doc_sources>\n提示\n</store_doc_sources>")).toBeNull();
  });
});
