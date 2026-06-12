/** 微信内置浏览器检测。
 *
 * 目标用户的链接几乎都在微信群里传播,微信 WebView 是最主流的打开方式,
 * 但它有两个硬限制:
 * 1. `<a download>` 不生效 —— fetch 成功但 a.click() 静默无效,图片/CSV 下不下来
 * 2. navigator.clipboard 在部分版本不可用
 * 所有下载/复制入口都要按此降级(长按保存 / execCommand 兜底)。
 */
export function isWeChat(): boolean {
  if (typeof navigator === "undefined") return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}
