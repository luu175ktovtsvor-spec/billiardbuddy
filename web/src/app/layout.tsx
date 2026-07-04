import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#F2F2F7",
};

export const metadata: Metadata = {
  title: "球房 AI 运营助手",
  description: "台球房行业本地 AI 运营助手",
  manifest: "/manifest.json",
  icons: {
    icon: "/app-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* P1-10 深浅色防闪烁:paint 前按 localStorage("theme")/系统色给 <html> 设 .dark,避免先亮后暗的闪一下。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();',
          }}
        />
        {/* B4 字号三档防闪烁:paint 前按 localStorage("fontSize") 给 <html> 设 CSS zoom,避免先标准后变大的跳一下。
            用法和取值见 lib/font-size.ts(标准/大/特大 三档,换算成相对标准档的缩放比例)。 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              '(function(){try{var f=localStorage.getItem("fontSize");var z=f==="large"?17.5/16:f==="xlarge"?19/16:1;if(z!==1){document.documentElement.style.zoom=String(z);}}catch(e){}})();',
          }}
        />
      </head>
      <body className="min-h-screen bg-[#F2F2F7] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
