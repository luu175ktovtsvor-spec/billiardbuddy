import type { Metadata } from "next";
import { LandingPage } from "../_components/Landing";

export const metadata: Metadata = {
  title: "图片与视频工作台",
  description: "从图片候选与局部编辑，到视频素材、时间线和导出，整个创作过程都在同一个桌面应用中完成。",
};

export default function StudioPage() {
  return <LandingPage />;
}
