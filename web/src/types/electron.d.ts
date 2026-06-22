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
    /** 发布功能是否可用(发布内核存在或本机有 python3);不可用时前端隐藏入口/给说人话提示。 */
    available(): Promise<{ ok: boolean; reason?: "no_worker" | "no_python" }>;
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
  files: {
    /** 弹系统文件/文件夹选择器,返回绝对路径;随对话以 selected_files 传后端授权 Agent 读/改。 */
    pick(opts?: {
      title?: string;
      multi?: boolean;
      directory?: boolean; // true=选文件夹(授权整个目录),否则选文件
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; paths: string[] }>;
    /** 系统「另存为」：把成品(base64 字节)写到用户选定的位置(桌面/任意文件夹)。 */
    save(opts: {
      defaultName?: string;
      base64: string;
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; path?: string; error?: string }>;
  };
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

export {};
