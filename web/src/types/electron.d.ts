// 桌面端(Electron)经 preload contextBridge 注入的 window.electron 接口类型。
// 浏览器(web 版)没有 window.electron——前端据此判断是否桌面端、显不显发布/剪辑入口。
// 与 desktop/src/preload.js 的 exposeInMainWorld("electron", ...) 保持一致。

export interface DesktopInfo {
  isDesktop: boolean;
  version: string;
  platform: string;
  backendUrl?: string | null;
  backendReady?: boolean;
  downloadsPath?: string;
  /** 首启自动建好的作品文件夹(如 ~/Documents/台球助手)，AI 产出默认落这里；建失败为 null。 */
  workspaceDir?: string | null;
  windowCount?: number;
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

export interface ModelStatus {
  phase: "idle" | "downloading" | "ready" | "error";
  percent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  file?: string;
  error?: string;
}

export interface ElectronBridge {
  info(): Promise<DesktopInfo>;
  /** 新开一个独立工作台窗口（各自有自己的会话、工作目录、任务订阅）。 */
  newWindow?(): Promise<{ ok: boolean; windowCount?: number; id?: number; workbenchId?: string }>;
  /** 打开「生成工作室」独立窗口（/dashboard/studio 路由）。 */
  openStudio?(): Promise<{ ok: boolean; id?: number }>;
  openVideoStudio?(): Promise<{ ok: boolean; id?: number }>;
  /** M2：工作室出了成品，通知其它窗口刷新「最近作品」。 */
  notifyStudioArtifact?(payload: { kind?: string; generationId?: string; url?: string }): Promise<{ ok: boolean }>;
  /** M2：订阅其它窗口（工作室）的成品事件，回调里刷新「最近作品」。返回取消订阅函数。 */
  onStudioArtifact?(cb: (p: { kind?: string; generationId?: string; url?: string }) => void): () => void;
  /** 截取当前屏幕并保存为临时 PNG，返回本机路径；前端作为附件发给 Agent。 */
  captureScreen?(): Promise<{ ok: boolean; path?: string; width?: number; height?: number; error?: string; needsPermission?: boolean }>;
  /** F1b：弹一条系统原生通知(跨平台)。渲染进程轮询后端通知中心拿到新条目后调用；
   *  故障安全——不支持/失败都返回 { ok:false }，不抛异常。 */
  notification?: {
    show(opts: { title?: string; body: string }): Promise<{ ok: boolean; error?: string }>;
  };
  /** 口播模型(whisper 1.4G)按需下载:首启后台下,下好前口播功能灰掉。 */
  models?: {
    status(): Promise<ModelStatus>;
    retry(): Promise<{ ok: boolean }>;
    onProgress(cb: (s: ModelStatus) => void): () => void;
  };
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
      defaultPath?: string; // 弹窗默认打开的位置，例如用户的下载文件夹
      multi?: boolean;
      directory?: boolean; // true=选文件夹(授权整个目录),否则选文件
      createDirectory?: boolean; // true=弹窗里显示"新建文件夹"按钮(Task 9 壳层支持)
      filesAndFolders?: boolean; // true=一个弹窗里文件或文件夹都能选(macOS),且不按类型过滤(P0-1)
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; paths: string[] }>;
    /** 贴图/拖图：把粘贴/拖入的图片(base64)存临时文件，返回路径；塞进 selected_files 让 AI 看。 */
    saveTemp(opts: { base64: string; ext?: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
    /** Electron 33+ 拿拖入/粘贴文件的本机路径（替代已移除的 File.path）。 */
    getPathForFile(file: File): string;
    /** 系统「另存为」：把成品(base64 字节)写到用户选定的位置(桌面/任意文件夹)。 */
    save(opts: {
      defaultName?: string;
      base64: string;
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; path?: string; error?: string }>;
    /** 在系统文件管理器中定位文件。 */
    showInFolder?(path: string): Promise<{ ok: boolean; error?: string }>;
    /** 用系统默认应用打开文件。 */
    openPath?(path: string): Promise<{ ok: boolean; error?: string }>;
    /** C1 首启特例：扫「桌面 + 作品文件夹」顶层，找最近一份表格报表(只读文件名)，返回 { name, path } | null。 */
    scanReports?(): Promise<{ name: string; path: string } | null>;
  };
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

export {};
