// 把 ts-desktop 前端两文件编进 sidecar 二进制:bun --compile 后 import.meta.dir 指向虚拟 bunfs,
// 读不到真实 desktop/renderer → 打包后 Electron 用 http://host:port/ 加载前端时首页 404。
// 用 `with { type: 'text' }` 让 Bun 把内容嵌进二进制(dev 下也返回真实内容),作为
// serveFrontendAsset 文件系统查找失败后的兜底,保证打包后 sidecar 也能 serve 前端。
// tsc 按扩展名把 .html/.js import 推成 HTMLBundle/模块类型(不识别 `type: 'text'` 属性),
// 运行期 Bun 给的是文件文本;显式当 string 用。
import indexHtmlRaw from '../../desktop/renderer/index.html' with { type: 'text' }
import appJsRaw from '../../desktop/renderer/app.js' with { type: 'text' }

const indexHtml = indexHtmlRaw as unknown as string
const appJs = appJsRaw as unknown as string

/** 归一后的路由路径(前导 '/') → { 内容, Content-Type }。'/' 归一到 '/index.html'。 */
export const EMBEDDED_FRONTEND: Record<string, { body: string; contentType: string }> = {
  '/index.html': { body: indexHtml, contentType: 'text/html; charset=utf-8' },
  '/app.js': { body: appJs, contentType: 'text/javascript; charset=utf-8' },
}
