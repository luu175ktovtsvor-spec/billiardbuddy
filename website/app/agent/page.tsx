import type { Metadata } from "next";
import { LandingPage } from "../_components/Landing";

export const metadata: Metadata = {
  title: "任务空间",
  description: "在同一个项目中查看对话、计划、执行过程、文件变化和最终结果。",
};

export default function AgentPage() {
  return <LandingPage />;
}
