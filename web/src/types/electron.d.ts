// 桌面端(Electron)经 preload contextBridge 注入的 window.electron 接口类型。
// 浏览器(web 版)没有 window.electron——前端据此判断是否桌面端、显不显发布/剪辑入口。
// 与 desktop/src/preload.js 的 exposeInMainWorld("electron", ...) 保持一致。

export interface DesktopInfo {
  isDesktop: boolean;
  version: string;
  platform: string;
}

export type LoginStatus = "waiting" | "scanned" | "success" | "expired" | "error";

export interface PublishContent {
  videoPath: string;
  title: string;
  tags: string[];
  coverPath?: string;
  scheduleAt?: string; // ISO
}

export interface PublishPlatform {
  id: string;
  name: string;
  enabled: boolean;
}

export interface ElectronBridge {
  info(): Promise<DesktopInfo>;
  publish: {
    platforms(): Promise<PublishPlatform[]>;
    startLogin(platform: string): Promise<{ ok: boolean }>;
    checkLogin(platform: string): Promise<{ loggedIn: boolean }>;
    post(platform: string, content: PublishContent): Promise<{ ok: boolean; url?: string }>;
    onQrcode(cb: (p: { platform: string; dataUrl: string }) => void): () => void;
    onLoginStatus(cb: (p: { platform: string; status: LoginStatus; msg?: string }) => void): () => void;
    onProgress(cb: (p: { platform: string; stage?: string; pct?: number; msg?: string }) => void): () => void;
  };
  video: {
    probe(inputPath: string): Promise<{ durationSec: number; width: number; height: number }>;
    run(op: string, args: Record<string, unknown>): Promise<{ ok: boolean }>;
    onProgress(cb: (p: { op: string; pct?: number }) => void): () => void;
  };
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

export {};
