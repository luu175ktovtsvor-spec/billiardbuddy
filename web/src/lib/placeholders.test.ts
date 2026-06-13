import { describe, it, expect } from "vitest";
import { findPlaceholders } from "./placeholders";

// #2 占位符填空：识别 AI 产出里需要用户补的占位符（如 [请补充：XX元]、【请填写】）
describe("findPlaceholders", () => {
  it("方括号占位符全部识别", () => {
    expect(findPlaceholders("余额[请补充：XX元]，名字[请填写]")).toEqual([
      "[请补充：XX元]",
      "[请填写]",
    ]);
  });

  it("全角括号只在含'请填写/请补充'时算占位，不误伤【方案一】这种标题", () => {
    expect(findPlaceholders("【方案一】标题…报名费【请填写】元")).toEqual(["【请填写】"]);
  });

  it("没有占位符返回空数组", () => {
    expect(findPlaceholders("今天空台多，来打球")).toEqual([]);
  });

  it("重复占位符去重", () => {
    expect(findPlaceholders("[请填写] 和 [请填写]")).toEqual(["[请填写]"]);
  });
});
