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
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#F2F2F7] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
