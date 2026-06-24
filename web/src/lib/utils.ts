import { ApiError } from "@/types/api";

/** 列表/详情时间戳:去掉秒("2026/6/12 14:30"),扫列表不用读到秒级噪音 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 文件名安全化：去掉 Windows/Mac 文件系统非法字符 */
export function safeFileName(s: string): string {
  return (s || "").replace(/[\\/:*?"<>|\n\r]+/g, "").trim().slice(0, 60) || "图片";
}

/** 下载图片为本地文件（带友好命名）。失败则新标签打开兜底。 */
export async function downloadImage(absoluteUrl: string, filename: string): Promise<void> {
  try {
    const res = await fetch(absoluteUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename.endsWith(".jpg") ? filename : filename + ".jpg";
    a.click();
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(absoluteUrl, "_blank");
  }
}

/**
 * Markdown 转纯文本：复制到微信/朋友圈不再满屏 ** 和 ##。
 * 表格行保留单元格文字（只去竖线），不丢内容。
 */
export function markdownToPlainText(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+\s*$/gm, "")
    .replace(/^\|[-:\s|]+\|\s*$/gm, "") // 表格分隔行删除
    .replace(/^\|(.+)\|\s*$/gm, (_m, cells: string) =>
      cells.split("|").map((c: string) => c.trim()).join("  ")
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 复制纯文本，带真实成功校验。
 * 微信 WebView/老浏览器里 clipboard API 和 execCommand 都可能静默失败——
 * 返回布尔，调用方据此提示"已复制"或"长按手动复制"，绝不显示假的"已复制"。 */
export async function copyPlainText(plain: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(plain);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = plain;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      // readonly：避免 iOS 弹出键盘顶乱页面
      textarea.setAttribute("readonly", "");
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, plain.length); // iOS 必需
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401: return "本地身份异常，请重启 App";
      // 400 多是友好的业务校验提示(短),可透传;但过长/像技术细节(堆栈/异常类名)的别甩给老板(G.3)
      case 400: return err.detail && err.detail.length < 100 && !/Error|Exception|Traceback|\bat\b/i.test(err.detail)
        ? err.detail : "这次请求有点问题，调整一下再试试";
      case 404: return "请先创建或完善门店资料";
      case 422: return "请检查输入内容";
      // 429 透传后端文案:带具体上限和提额引导("联系您的服务商"),
      // 别替换成"下月再试"——那是把想付费的用户劝走
      case 429: return err.detail || "本月生成次数已达上限。";
      // G.3：5xx 多是后端 Python 异常,绝不把技术细节(堆栈/异常类名)原样甩给非技术店主 → 统一人话
      case 500:
      case 502:
      case 503:
      case 504: return "服务出了点小状况，稍等一下再试一次";
      default: return "服务出了点小状况，稍等一下再试一次";
    }
  }
  if (err instanceof TypeError && err.message === "Failed to fetch") {
    return "网络异常，请检查后重试";
  }
  return "生成失败，请稍后重试";
}
