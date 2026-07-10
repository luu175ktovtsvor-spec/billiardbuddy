# Codex/WorkBuddy 逆向笔记(反哺后续板块,2026-07-11)

## 一、Codex 真实 token(源自 docs/references/竞品拆解/02-前端设计-配色与质感.md §3.1,
取证文件 `app-jOJotR-N.css`,该份逆向产物本机已找不到原文件,以文档里摘录的真值为准,不是脑补)

- 12 级灰阶:`#fff/#f9f9f9/#ededed/#afafaf/#5d5d5d/#4f4f4f/#414141/#303030/#282828/#212121/#181818/#0d0d0d`
- 正文色 `--color-text-foreground: #1a1c1f`(带蓝紫的深灰,不是纯黑)
- **唯一强调色 `--blue-300: #339cff`,全篇只用在 1 处 = 键盘聚焦环(`--color-border-focus`)**。
  Codex 工具行/文件名/面包屑/树状目录**通篇不用蓝色**,全部走同一个文字色变量的透明度分级
  (hover/active/inactive = `color-mix(...6%/10%/16%/24%)`),连边框都锚定同一个变量。
  → 这解释了我这版截图里 Codex 的文件名是**近黑+hover 下划线**,不是蓝的;我们工具行文件名
  用蓝色是照 **WorkBuddy** 的真实 token(`cb-* 语义色`"文字 link/hover" `#006ab1/#0E58A0`
  浅色、`#3794ff/#7AB8E8` 深色),两家不是同一套,别搞混来源。
- 边框:`color-mix(in oklab, var(--color-text-foreground) N%, transparent)`,N=5%(light)/
  12%(heavy)/12~20%(elevation)——四级都锚定同一个文字色变量,不是各自写死的固定灰。
- 圆角:`--radius-2xs-base .125rem`(2px)→ `--radius-4xl-base 1.5rem`(24px),且有一个
  **整体倍率开关 `--corner-radius-scale`**(默认 1,来自 `--codex-corner-radius-scale`)——
  圆角可以被一个设置项整体缩放,不是散落的写死数字。**这个模式值得抄:以后我们做"圆角风格"
  设置项(如果要做)可以照这个"单一 scale 变量"实现,别挨个改组件。**
- 字体:正文系统字体栈,等宽 `ui-monospace/SFMono-Regular/SF Mono`;"OpenAI Sans" 只在
  `.font-openai-sans` 工具类里出现,不是全局字体。

## 一.5、补充实测(2026-07-11 现场解包 `/Applications/ChatGPT.app/Contents/Resources/app.asar`
验证,Codex 就装在 ChatGPT.app 里,`codex` 二进制 + `com.openai.codex.manifest` 在同一个 Resources
下;`npx @electron/asar extract` 解包到 `/tmp/codex_asar_fresh` 现场读 `webview/assets/app-C_Uac7Z9.css`
615KB,逐条 grep 核对,数值和竞品拆解 02 记录的完全一致,补一个新发现):

- Codex 的 CSS 里还有一层 `--color-token-text-link-foreground: var(--vscode-textLink-foreground)`——
  这是**转发给内嵌 VS Code 主题的 `textLink.foreground`**,不是 Codex 自己定义的颜色。VS Code
  Light+/Dark+ 内置主题的 `textLink.foreground` 默认值正好就是 `#006ab1`(浅)/`#3794ff`(深)——
  和我们从 WorkBuddy `cb-*` 语义色表摘到的"文字 link/hover"数值**完全对上**。说明两家的文件
  链接蓝其实都是**同一个源头:VS Code 默认主题的 textLink 色**(两家工具行/diff 面板大概率都
  内嵌了 vscode webview 组件来显示代码/文件),不是各自品牌色。**结论:我们工具行文件名用这
  个蓝色,是在用"代码编辑器语境下的行业默认链接色",不是照搬某一家的品牌色,选得对、来源
  比想的更硬。**
- Codex 真正广泛使用的强调蓝还多了一处:`--color-icon-accent: var(--blue-300)`(图标强调色),
  不止文档记的"聚焦环"这一处,但依然是极窄的点缀用法,不影响上面"Codex 工具行文件名本身不
  是蓝色"的结论。

## 二、这一版已经按上面校准过的地方

- `theme/workbuddy-tokens.css` 新增 `--color-link`/`--color-link-hover`(浅 #006ab1/#0E58A0、
  深 #3794ff/#7ab8e8)——**来源 WorkBuddy 的 cb-* 语义色表,不是 Codex**。工具行文件名用它。
- `globals.css` 新增 `.qf-tool-link` 工具类(色 + hover 加下划线),给任何"文件名链接"复用。

## 三、Codex 真机截图里看到、这版没做、留给下一片的板块(按 owner 指示"顺手记一笔反哺后面")

1. **右侧文件预览完整版**(这版只做了最基础的单文件+行号,下面这些没做):
   - **多标签页 tab 条**:每个打开过的文件一个 tab(如"审阅/permissionUpdate.ts/filePathRules.ts/
     canonical.ts"),+ 号新增、全屏/最小化/收起图标在右上角。
   - **面包屑**:`项目名 > ts > src > permissions > canonical.ts`。
   - **右侧文件夹树状图**:搜索框"筛选文件..." + 缩进树,当前打开文件高亮(浅蓝底选中条,
     WorkBuddy 那套"cb-hover-bg"风格),文件按扩展名给不同小色块图标(TS 蓝方块/JSON花括号/
     MD 图标等)。
   - **代码带语法高亮**(这版只做了行号+纯色文本,没做 tokenize 高亮)。
   - **"打开"下拉按钮**(右上角,大概率是"用外部编辑器打开"这类动作)。
   - 文件改动统计条:`+92 -0` 这种绿/红数字,配 diff 视图切换图标。

2. **"环境信息"卡**(Codex 右侧栏,当前没打开文件时的默认态):
   - 卡片:`变更 +128,261 -132,613`(绿/红两色数字)、`本地`(可展开)、`main → origin/main`
     (分支箭头行,可展开看 ahead/behind)、`提交或推送`、`比较分支`(带跳转 GitHub 图标)。
   - 这套是"这个任务/会话挂在哪个 git 状态上"的一次性摘要卡,我们如果做"任务详情"或
     "工作区状态"面板可以照这个信息密度做。

3. **"···"更多菜单**(任务标题栏,通用右键/更多菜单模式,值得复用到别处):
   - 分组结构:置顶任务(⌥⌘P)/ 重命名任务(⌥⌘R)/ 归档任务(⇧⌘A)— 分隔线 —
     打开侧边任务(⌥⌘S)/ 复制(▸ 子菜单)/ 在...中继续(▸ 子菜单)/ 添加计划任务...(禁用态灰字)
     — 分隔线 — 在新窗口中打开。
   - 每项:图标 + label + 右对齐快捷键标签(灰字);有子菜单的项右侧带 `▸` 箭头。
   - 这是个通用"任务卡右键菜单"范式,和 WorkBuddy 逆向档案 20 号文档提到的任务卡右键菜单
     是同一类交互,以后做左侧任务列表的右键菜单可以直接参照这个信息架构。

4. **多步进度胶囊 "第 N/M 步"**:这版已经吸收(`StreamingIndicator.tsx` 里的
   `StepProgressPill`,复用现有 todos 数据算 current/total),但 Codex 原版是浮在内容中间
   一个独立的圆角小胶囊(不在气泡里),这版做法一致。

5. **底部输入区细节**:"要求后续变更"占位符;权限提示是橙色感叹号 + "完全访问"文字(不是
   绿色);模型强度是个数字+文字双段选择器(`5.5` + `极高`);运行中发送键变成黑色方块
   (停止态),这几个和我们现有 Composer 的权限/模型选择器已经是同类范式,细节可以对照抄。

6. **终端 tab**:任务详情顶部除了"审阅"还有独立的终端 tab,可以看到实时命令行(乱码是
   本地终端编码问题,不是 Codex 的 bug),说明它把"审阅(diff)"和"终端(实时输出)"分成
   两个平级 tab,而不是把终端输出塞进对话流——这个信息架构下一片做"运行态可视化"时可以
   参考:要不要也拆一个独立终端视图,而不是全部堆进工具行折叠输出里。

## 四、给下一个执行者的提醒

- 这次新建的 `filePreviewStore.ts`(`src/stores/`)、`FilePreviewPanel.tsx`
  (`src/components/workspace/`)、`Tooltip.tsx`(`src/components/shared/`)都是**全局通用件**,
  没有写死只服务对话中间列——下一片做完整右侧面板(多标签/树/面包屑)时,应该是在
  `FilePreviewPanel` 基础上**扩展**(加 tab 状态、加树状组件),不是推倒重写;
  `useFilePreviewStore.openFile(path)` 这个契约名不要改,后面各处"点文件名"都应该调它。
- `--color-link`/`--color-link-hover` 和 `.qf-tool-link` 已经是全局 token/class,后面文件树
  高亮当前文件、面包屑链接都可以直接吃,不用重新定义一套。
