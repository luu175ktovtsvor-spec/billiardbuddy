import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteOrigin = "https://billiardbuddy.zzyppz.cn";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: {
    default: "BilliardBuddy — 进入真实工作，留下真实结果",
    template: "%s · BilliardBuddy",
  },
  applicationName: "BilliardBuddy",
  category: "productivity",
  keywords: ["BilliardBuddy", "桌面 AI 工作空间", "AI Agent", "项目文件处理", "图片工作台", "视频工作台", "Windows", "macOS"],
  description: "用一个桌面应用完成任务、图片和视频工作，并留下可以继续修改的结果。",
  alternates: { canonical: siteOrigin },
  robots: { index: true, follow: true },
  icons: { icon: "/app-icon.png", shortcut: "/app-icon.png", apple: "/app-icon.png" },
  openGraph: {
    title: "BilliardBuddy — 进入真实工作，留下真实结果",
    description: "在同一个桌面应用里完成任务、制作图片、剪辑视频。",
    url: siteOrigin,
    siteName: "BilliardBuddy",
    locale: "zh_CN",
    type: "website",
    images: [{ url: "/billiardbuddy-workspace-og.png", width: 1200, height: 630, alt: "BilliardBuddy 桌面 AI 工作空间" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "BilliardBuddy — 进入真实工作，留下真实结果",
    description: "在同一个桌面应用里完成任务、制作图片、剪辑视频。",
    images: ["/billiardbuddy-workspace-og.png"],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f3f0e8",
};

const softwareApplicationData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "BilliardBuddy",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Windows 10, Windows 11, macOS",
  url: siteOrigin,
  description: "在任务、图片和视频三个桌面工作空间中完成项目文件处理、图片生成编辑与现有视频素材剪辑。",
  featureList: ["项目任务、工具执行与文件审阅", "运行中调整、任务队列与失败恢复", "图片参考、候选生成、局部编辑、图层排版与版本管理", "视频素材理解、时间线、旁白、混音、字幕、预览与本地导出", "定时任务、Skills、Plugins 与 MCP 扩展", "模型、权限、数据位置和桌面体验可配置", "Windows 与 macOS 桌面应用"],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationData).replace(/</g, "\\u003c") }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
