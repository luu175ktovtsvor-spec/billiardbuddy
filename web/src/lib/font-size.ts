// B4：设置抽屉「外观」区的三档字号(标准/大/特大)，专给老板年龄层用，一眼能看清楚。
// ⚠️ 实现选型说明（和施工单原话"改根 font-size,rem 自动放大"不同,这里做了验证后的调整）：
// 实测本项目文字尺寸绝大多数是 Tailwind 任意值 `text-[13px]` 这类【字面 px】，不是
// `text-sm`/`text-base` 这类 rem 相对值（统计：412 处 text-[Npx] vs 仅 12 处 rem 默认档）。
// 只改 <html> 根 font-size 对这 97% 的文字不起作用（px 不随根 font-size 缩放）。改用 CSS
// `zoom`：桌面壳是 Electron（Chromium 内核），zoom 属性被 Blink 原生支持（等同浏览器
// Ctrl+ / Ctrl- 页面缩放），会整体按比例放大文字 + 间距 + 图标——正是"老年人友好"要的效果，
// 且仍然只碰根节点、不逐组件改（符合施工单"别逐组件改字号"的约束，只是换了能真正生效的 CSS 机制）。
export type FontSizeMode = "standard" | "large" | "xlarge";
const KEY = "fontSize";

// 对应施工单给的三档基准(16 / 17.5 / 19px)换算成相对标准档的缩放比例。
const ZOOM: Record<FontSizeMode, number> = {
  standard: 1,
  large: 17.5 / 16,
  xlarge: 19 / 16,
};

export function getFontSize(): FontSizeMode {
  if (typeof window === "undefined") return "standard";
  const v = localStorage.getItem(KEY);
  return v === "large" || v === "xlarge" ? v : "standard";
}

export function applyFontSize(mode: FontSizeMode): void {
  if (typeof window === "undefined") return;
  if (mode === "standard") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  document.documentElement.style.zoom = String(ZOOM[mode]);
}
