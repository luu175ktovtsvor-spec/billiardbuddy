import { describe, expect, test } from "vitest";

import { questionFieldAnswerDisplay, safeExternalQuestionUrl } from "./question-answer-display";

describe("questionFieldAnswerDisplay", () => {
  test("formats MCP form answers without dumping raw JSON keys", () => {
    expect(questionFieldAnswerDisplay([
      { name: "city", label: "城市", type: "text" },
      { name: "channels", label: "渠道", type: "multiselect" },
      { name: "urgent", label: "加急", type: "boolean" },
      { name: "empty", label: "空项", type: "text" },
    ], {
      city: "上海",
      channels: ["朋友圈", "社群"],
      urgent: true,
      empty: "",
    })).toBe("城市：上海\n渠道：朋友圈、社群\n加急：是");
  });

  test("allows only explicit http/https URLs for question link actions", () => {
    expect(safeExternalQuestionUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(safeExternalQuestionUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalQuestionUrl("javascript:alert(1)")).toBe("");
    expect(safeExternalQuestionUrl("//example.com")).toBe("");
    expect(safeExternalQuestionUrl("/uploads/poster.png")).toBe("");
  });
});
