import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function source(fileName: string): string {
  return readFileSync(resolve(here, fileName), "utf8");
}

describe("high-exposure system copy", () => {
  test("keeps store docs copy neutral and source-oriented", () => {
    const text = source("store-docs-panel.tsx");
    expect(text).toContain("选择店铺资料文件夹");
    expect(text).toContain("未找到相关片段。");
    expect(text).toContain("清除后将不再用于回答；原文件不会删除。");
    expect(text).not.toMatch(/选一个装着|开始整理了|没弄成|试搜店铺文件|我会忘记/);
  });

  test("keeps store memory naming consistent", () => {
    const combined = [
      source("store-memory-panel.tsx"),
      source("settings-drawer.tsx"),
    ].join("\n");
    expect(combined).toContain("门店记忆");
    expect(combined).toContain("已确认");
    expect(combined).toContain("自动记录");
    expect(combined).not.toMatch(/我的球房资料|AI 记的事|我确认的|已记下|AI学到/);
  });

  test("keeps scheduled task copy in tool UI voice", () => {
    const text = source("scheduled-tasks-panel.tsx");
    expect(text).toContain("自动执行一项任务");
    expect(text).toContain("执行内容");
    expect(text).not.toMatch(/帮你干一件事|要它干啥|先填个名字/);
  });

  test("labels knowledge answers as cited store files", () => {
    const text = source("chat-thread.tsx");
    expect(text).toContain("引用的店铺文件");
    expect(text).toContain("引用原因");
    expect(text).toContain("匹配词");
    expect(text).toContain("摘录");
    expect(text).not.toContain("店铺资料来源");
  });
});
