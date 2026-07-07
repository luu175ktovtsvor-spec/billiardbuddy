import { describe, expect, test } from "vitest";

import { extractAssistantOutputTarget } from "./assistant-output-targets";

describe("extractAssistantOutputTarget", () => {
  test("detects explicit copy deliverables from plain assistant text", () => {
    const target = extractAssistantOutputTarget(`【朋友圈文案】
标题：今晚黄金档，来打一局刚刚好

正文：今天 19:00-22:00 到店开台，会员可享黄金档专属福利。三五好友约一桌，打完还能参加店内小挑战。

评论区引导：想约几点，直接留言，我帮你留台。`);

    expect(target).toMatchObject({
      kind: "copy",
      title: "朋友圈文案",
    });
    expect(target?.spec).toMatch(/^文案 · \d+字$/);
  });

  test("detects structured plans even without a bracket heading", () => {
    const target = extractAssistantOutputTarget(`活动方案：

目标：把周五晚上的空台率压下来，让老会员带新客到店。
玩法：19:00 前进店开台满两小时，第二小时半价；老会员带一位新客到店，送一份小食券。
步骤：店长今天下午发客户群，前台准备登记表，助教负责提醒续台。
预算：小食券控制在 8 元以内，活动只跑一晚先看转化。`);

    expect(target).toMatchObject({
      kind: "plan",
      title: "活动方案",
    });
  });

  test("does not turn ordinary explanations into preview cards", () => {
    const target = extractAssistantOutputTarget("这个问题的原因是工具结果太长，压缩时没有保留最近读过的文件，所以模型后续会丢上下文。建议先补回最近文件上下文，再用测试锁住行为。");

    expect(target).toBeNull();
  });
});
