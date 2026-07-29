import type { Metadata } from "next";
import { LandingPage } from "../_components/Landing";

export const metadata: Metadata = {
  title: "关于 BilliardBuddy",
  description: "BilliardBuddy 把任务、图片和视频带进一个持续工作的桌面空间。",
};

export default function CompanyPage() {
  return <LandingPage />;
}
