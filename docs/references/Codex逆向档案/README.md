# Codex(ChatGPT.app 内置)前端逆向档案

> 📌 状态:✅现行 · 最后核对 2026-07-11
> 🎯 **Codex 比 WorkBuddy 做得好 → 我们桌面前端以本档(Codex)为首要参照,只在个别更优处融合 WorkBuddy。** 交互/信息架构/组件形态一律以 Codex 为准;WorkBuddy 参照见 `../WorkBuddy逆向档案/`。

## 这份档案是什么

对 **ChatGPT.app 里内置的 Codex 前端**做的一手逆向。取证方式 = **解包本地安装的 app,直接读它 bundle 里的真实 CSS/JS/图标/字体**——不是看截图猜、不是脑补。所有数值都能在 `真实CSS摘录/` 里回查到原文件。

## 取证方法(可复现,和当年扒 WorkBuddy 同一套路)

| 项 | 值 |
|---|---|
| app 位置 | `/Applications/ChatGPT.app`(**Codex 就装在 ChatGPT 里**,同目录有 `codex` 二进制 + `com.openai.codex.manifest` + `codex-code-mode-host`) |
| 前端 bundle | `Contents/Resources/app.asar`(194 MB · 2026-07-10 版) |
| 解包 | 全局 `asar` v4.2.0 / node `require('asar').extractFile(archive, 'webview/assets/xxx.css')`;前端资产都在 asar 内 `webview/assets/` |
| 抠到的真实资产 | **28 个 CSS**(主样式 `app-C_Uac7Z9.css` 615 KB,含 **1834 条设计 token**)、**lucide 图标 JS 块 149 个**(+`createLucideIcon` 模块实锤)、**shiki 语法高亮**(按语言切 grammar `abap/actionscript-3/...` + 主题 `absolutely-dark/light`)、KaTeX 数学字体等 |

复现命令(留档):
```bash
ASAR=/Applications/ChatGPT.app/Contents/Resources/app.asar
asar list "$ASAR" | grep -i '\.css$' # 看有哪些样式
node -e 'require("asar").extractFile(process.env.ASAR,"webview/assets/app-C_Uac7Z9.css")' # 抠主样式
```

## 一句话结论:Codex 前端长什么样

**暖中性底 + 近黑文字(`#1a1c1f`,带一丝蓝调、不是纯黑)+ 极窄蓝点缀**(蓝只在焦点环/图标强调两处用 `--blue-300 #339cff`,工具行/文件名/面包屑通篇不用蓝)。**主按钮 = 文字前景色本身(近黑)**;所有 hover/active/边框/图标层级都**锚定同一个前景色变量做透明度分级**(`color-mix(... N%, transparent)`),不是各自写死的灰。

布局 = **三栏**:左会话/项目导航 · 中对话流 · 右**可开合的代码审阅面板**(多 tab + 面包屑 + diff 视图 + 文件树带增删徽标 + 环境信息卡)。

**低噪工具流**:工具调用是一行行**带 lucide 图标的过去式小行**(「已运行 git log」「已读取 resolve.ts」「已在 ts 中搜索…」),文件名是**可点的近黑链接、hover 才加下划线**;多个读文件折叠进一个「已读取文件 ▾」;思考是一条灰色可折叠预览行;多步任务浮一个「第 N/M 步」圆角胶囊。

技术栈:**Tailwind v4.2.4 + CSS 变量设计 token + CSS Modules(哈希类名)+ lucide 图标 + shiki 高亮 + 内嵌一层 VS Code 主题(`--vscode-*`)驱动代码/diff 面**。

## 目录

| 文件 | 内容 |
|---|---|
| `01-设计系统.md` | **真实设计 token**:双层配色模型、原子调色板、语义色规则、圆角/间距/字体/阴影、diff 色、图标体系;附「Codex token → 我们 token」映射 |
| `02-布局与外壳.md` | 三栏骨架、侧栏、顶栏、右侧面板开合与拖拽分割线 |
| `03-对话流与组件.md` | 助手消息/用户气泡/工具行/思考块/步骤胶囊/处理时长/消息动作条/输入区(含强度滑杆、权限胶囊) |
| `04-右侧审阅面板.md` | 多标签 tab 条、面包屑、分支/改动统计、diff 视图、文件树徽标、环境信息卡、更多菜单 |
| `05-我们前端怎么做.md` | **落地指南**:每块 Codex 元素映射到我们真实的 React 组件(`ts/desktop/renderer-react/`),标出 main 上还差什么、择优融合 WorkBuddy 的哪几点 |
| `06-斜杠命令浮层.md` | **斜杠命令 autocomplete 完整规格**(反混淆 JS 组件读出,非仅 CSS):命令注册数据模型、分组/打分/排序管道、行 DOM 与选中态(非选中 75% 透明)、匹配字符高亮、scope 标签(个人/系统)、fade mask;附我们 TokenPanel 落地差异 |
| `Codex后端代码视图.md` | **后端逆向**:Codex 引擎 = 内嵌开源 `openai/codex`(Rust `codex-rs` 99 crate);SQ/EQ 协议、core 循环、tools、exec/execpolicy/sandboxing 三平台沙箱、MCP/连接器/技能、rollout 存储、cloud-tasks 定时、桌面 Electron 经 UDS 托管 app-server。来源 = 本地 asar + GitHub `openai/codex` |
| `Codex浏览器批注-基于此调整.md` | **右侧实时浏览器 + 可视化批注/设计修改**:悬停结构化框选 DOM、点框截图 + 输入指令、回传载荷 `AppScreenshot{url,fileId,userPrompt}`;附右侧预览板全能力(diff/审阅/Guardian/交互终端/计划/实时监听/线程分叉回滚/语音)。来源 = `comment-preload.js` + app-server-protocol schema |
| `截图/` | 9 张真机截图(webp/png) |
| `真实CSS摘录/` | 抠出的真实 CSS 文件 + `全部设计token-1834条.txt` |

## 真实截图速览

| 截图 | 看点 |
|---|---|
| `截图/01-三栏总览-对话与右侧diff审阅.webp` | 三栏全貌:左导航 / 中对话 / 右 diff 审阅 + 文件树 |
| `截图/02-工具行-步骤胶囊-环境信息卡.webp` | 工具行、折叠思考、「第 1/5 步」胶囊、右侧「环境信息」卡、输入区「完全访问 · 5.5 极高」 |
| `截图/03-任务标题更多菜单.webp` | 「···」更多菜单(置顶/重命名/归档… + 快捷键) |
| `截图/04-读文件工具行-可点文件名.webp` | 「已读取文件 ▾」折叠组 + 可点近黑文件名 |
| `截图/05-右侧文件树-改动徽标.webp` | 右侧文件树 + 每文件的 `+`/`−`/`•` 增删改徽标 |
| `截图/06-面包屑-源码查看.webp` | 面包屑 `项目 > ts > src > permissions > canonical.ts` + 源码查看 |
| `截图/07-右侧面板多标签tab条.png` | 「审阅 / permissi / filePath / readIgno …」多 tab 条 + 右上开合/全屏图标 |
| `截图/08-文件名hover路径提示.png` | 文件名 hover 出完整路径气泡 |
| `截图/09-分栏分割线-全景.png` | 中/右分栏可拖拽分割线全景 |
