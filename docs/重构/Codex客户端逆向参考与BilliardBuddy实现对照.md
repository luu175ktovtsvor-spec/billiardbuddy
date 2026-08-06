# Codex 客户端逆向参考与 BilliardBuddy 实现对照

## 这份文档解决什么问题

这不是 Codex 源码移植说明，也不是一份 UI 截图笔记。它把本机当前安装的 Codex 客户端 bundle 逆向得到的页面、状态和交互边界，与 BilliardBuddy 已经存在的 Electron IPC、preload 和 Rust App Server 能力逐项对齐，作为后续重写完整 Renderer 的施工依据。

它主要属于“前端 + Electron 宿主桥”参考，不包含可维护的 Codex Rust 后端源码。后端源码、BilliardBuddy 的生产接入和验证证据分别位于 `third_party/codex-engine`、`ts/desktop/electron` 以及 `docs/重构/Agent后端能力证据矩阵.md` 等文件中；不能只依赖安装包 bundle 判断后端能力。

结论先固定下来：

- Codex 安装包只提供信息架构、交互语义、组件边界和宿主调用线索；它不是 BilliardBuddy 的运行时依赖，也不是可直接发布的源代码。
- BilliardBuddy 的 Rust Codex App Server/Core 仍是 Thread、Turn、Item、工具、审批、上下文和恢复的唯一事实来源。Renderer 只能投影这些事实，不能再写一个 Agent Loop 或本地 Thread Store。
- 当前 BilliardBuddy 的 Electron Main、preload 和 Rust runtime 已经覆盖了大量客户端所需的真实后端入口；当前可见产品缺口集中在 Renderer：`ts/desktop/src/main.ts` 目前只挂载图片工作台，没有 Agent 客户端消费方。
- 第一批客户端工作不是“重做后端”，而是建立一个有类型的 `nativeAgent` bridge、一个事件归并器和一个以 Thread 为中心的 UI 投影层。

## 参考快照身份

当前参考以 `/Users/swl/Desktop/billiardbuddy/codex-frontend-reference/26.730.61639/` 为准：

| 项目 | 当前值 |
| --- | --- |
| 安装应用 | `/Applications/ChatGPT.app` |
| Bundle ID | `com.openai.codex` |
| 应用版本 | `26.730.61639` |
| Build | `6234` |
| 提取日期 | `2026-08-06` |
| `app.asar` SHA-256 | `3fea92820c0fb7a69473e7a8308a8e5b8e91524289a84181a33533ec6cb51d45` |
| Source map | 安装包未包含 |

当前快照包含完整 ASAR 提取、21 个 host bridge 编译产物、38 个高价值可读 bundle、当前安装包携带的 macOS arm64 编译运行时和第三方声明。`26.721.41059` 旧快照保留，只用于版本差异，不作为当前实现依据。

## 读取顺序

后续写客户端时按下面的优先级判断：

1. 先看 BilliardBuddy 当前共享契约、Main IPC 和 `ElectronCodexNativeRuntime` 的真实类型与校验。
2. 再看本文件的功能对照，确认应该投影哪些状态、调用哪个入口、哪个功能当前仍未接线。
3. 最后阅读逆向 bundle：优先 `reverse-readable/`，必要时再回到 `raw/webview/assets/` 查找调用关系。
4. 编译二进制只用于确认宿主边界、进程名称和能力存在，不从二进制反推未经验证的产品行为。

## 当前 BilliardBuddy 的真实状态

### Renderer 现状

当前入口 `/Users/swl/Desktop/billiardbuddy/ts/desktop/src/main.ts:1-42` 只做三件事：取得 `#root`、创建图片工作台客户端、挂载 `createImageWorkbenchShell`。没有 Agent Shell、Thread 列表、Composer、Turn 时间线或事件订阅。

这意味着后端证据矩阵中标记为“已接线”的能力，当前仍不能写成“用户已经能点击使用”。真正的第一步是替换 Renderer 装配方式，同时保留图片工作台的独立能力边界。

### preload 现状

`/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/preload.ts` 已经有一套较完整的 `nativeAgent`：

- `preload.ts:34-38` 订阅 `desktop:native-agent:event`，并返回可注销的监听函数。
- `preload.ts:44-464` 暴露 Thread、Turn、Review、模型、权限、Memory、Sections、Goal、终端、文件搜索、Worktree、Git、MCP、Skills、Hooks、Plugin、协作模式等入口。
- `preload.ts:465` 暴露 `onEvent`。
- `preload.ts:672-677` 将 `nativeAgent`、`media`、`models` 一起放入 `window.billiardBuddyNative`。

当前实际运行时已经暴露了 `nativeAgent`，但 `/Users/swl/Desktop/billiardbuddy/ts/desktop/src/vite-env.d.ts:8-12` 只给 `media` 和 `models` 做了类型声明，尚未给 `nativeAgent` 建立共享类型入口。这是客户端开工时必须优先处理的明确缺口，不应继续使用 `Record<string, unknown>` 掩盖它。

### Main 与 Rust runtime 现状

- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/main.ts:1117-1129` 的统一 `registerHandler` 会校验 renderer sender 和 IPC payload。
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/main.ts:1200-1219` 的 `startThread` 入口会校验工作区、权限并登记窗口所有权。
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/main.ts:521` 将 native notification 发回拥有该 Thread/Turn 的窗口；`main.ts:570-710` 负责 Thread、Turn、终端、搜索和 server request 的归属筛选与清理。
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/services/codexNativeAppServer.ts:1711-1717` 明确规定 Rust 私有 `CODEX_HOME` 下的 Thread Store 是唯一持久事实，Electron 只保留进程句柄、路由身份和短期映射。
- `codexNativeAppServer.ts:1781-1797` 通过 `thread/start` 创建源生 Thread；`2069-2107` 直接从 Rust Thread Store 读取 Thread、Turn、Item 历史，不创建 Electron 历史缓存。
- `codexNativeAppServer.ts:2969-3003` 只维护进程内 active turn、loaded thread 和 workspace 提示，并观察 `thread/started`、`turn/started`、`turn/completed` 等源生通知。
- `codexNativeAppServer.ts:3190-3218` 通过 `thread/resume` 恢复源生 Thread；恢复时重新取得 active turn，不以 Renderer 旧状态为准。

客户端必须据此分层：Main 负责安全和窗口所有权，Rust 负责 Agent 事实，Renderer 负责可丢弃的视图投影。

## 新版 bundle 的功能对照

状态含义：

- `桥已存在`：BilliardBuddy 的 preload/Main/runtime 已有真实入口，Renderer 尚未消费。
- `需要客户端`：后端边界已足够，缺的是页面、状态投影、错误态或用户流程。
- `需单独核验`：逆向 bundle 暴露了形态，但当前项目或跨平台成品还没有足够证据承诺等价行为。
- `不直接移植`：只保留交互语义，产品能力必须按 BilliardBuddy 自己的契约实现。

| Codex bundle 线索 | 逆向得到的客户端语义 | BilliardBuddy 真实入口 | 当前状态 | 客户端要做什么 |
| --- | --- | --- | --- | --- |
| `app-initial-CKNQDTeE.js`、`app-main-DRwiml1r.js` | 应用启动、路由、窗口级状态和全局动作 | Electron preload 的 nativeAgent/media/models，以及现有窗口 IPC | 需要客户端 | 建立 App Shell、启动加载、错误边界、窗口动作和统一导航；不要把 bundle 的路由实现原样搬进来 |
| `thread-app-shell-chrome-*`、`thread-side-panel-tabs-*`、`thread-browser-panel-tabs-*` | 任务外壳、侧栏、右侧面板和 Browser 面板是不同层级 | Thread/Turn/Item 读取、终端、Diff、Browser/Chrome policy 入口 | 桥已存在 | 先定义面板状态和 URL/Thread 作用域，再接真实内容；面板切换不能创建第二份 Thread 状态 |
| `new-thread-panel-page-DwClAa_M.js` | 新任务是独立流程，可选择工作目录/运行位置 | `nativeAgent.startThread`、模型设置、Worktree、workspace 校验 | 桥已存在 | 完成“选择工作区 -> 选择运行位置 -> 创建 Thread -> 进入 Thread”流程；任何 cwd 都必须由 Main 重新校验 |
| `local-conversation-page-*`、`local-conversation-thread-*` | 本地任务页承载历史、消息流、Composer、工具活动、审批和任务状态 | `listThreads`、`resumeThread`、`readThread`、`listThreadTurns`、`listThreadItems`、`onEvent` | 需要客户端 | 以 `threadId` 为主键实现加载、分页、实时增量、恢复和失败态；不要用本地 JSON/IndexedDB 代替 Rust Thread Store |
| `remote-conversation-page-BOPNqfI-.js` | 远程任务是另一条消费链 | 当前 BilliardBuddy 的 nativeAgent 是本地 Rust App Server 路径，未发现等价云 Thread UI 合同 | 需单独核验 | 不要先假设“远程任务”存在；若未来要支持，先补产品合同和真实后端证据，再增加路由 |
| `queued-message-list-C99nHasl.js` | 排队消息可排序、编辑、删除、Steer、暂停/重试，并可恢复 | `startTurn`、`steerTurn`、`interruptTurn`、`onEvent` | 桥已存在 | 队列必须是 Renderer 的可恢复临时状态，并明确 active turn、queued input、失败可重试三种状态；不要伪造已送入 Rust 的消息 |
| `composer-action-bar-run-location-dropdown-*`、`composer-project-selector-*`、`composer-utility-bar-*` | Composer 同时承载输入、运行位置、项目/工作区、模型/工具设置 | Thread start/turn、Worktree、模型配置、文件搜索、Appshot | 桥已存在 | 把 Composer 拆成纯输入状态和已提交 Turn；提交后以 Rust 通知和历史回读为准 |
| `thread-overflow-menu-BnGXLm0k.js` | 置顶、重命名、归档、复制 cwd/Session、侧边任务和继续任务属于 Thread 操作 | Thread metadata、archive/delete/unarchive、fork、sections、worktree | 桥已存在 | 逐项映射到现有 IPC；每个菜单动作都要处理权限失败、Thread 不再属于当前窗口和恢复后的 stale 状态 |
| `review-slash-command-submenu-registration-*` | Review 可 inline 或 detached，目标可以是未提交变更、分支、提交或自定义指令 | `nativeAgent.startReview`、Fork/Worktree、Turn 事件 | 桥已存在 | 先做真实 Review 结果投影，再做行级 comment；不能在 Renderer 自己拼一条“review prompt”冒充 Review Thread |
| `editor-diff-page-BQncFfkr.js` | Diff 是按 conversation/Thread 作用域的独立视图，有 unified/split、文件统计和富预览 | Git status/diff/stage/revert/patch、Thread Item、workspace 所有权 | 桥已存在 | 以 Main 返回的受控 workspace 和 unified diff 为事实；Renderer 不直接读任意路径或启动 git |
| `artifact-tab-content.electron-*`、`docx-preview-panel-*`、`pdf-preview-panel-*`、`notebook-preview-panel-*` | DOCX/PDF/Notebook/演示文稿/表格预览是并列 Artifact 面板 | 当前项目已有媒体 Sidecar；Agent 文件/Artifact 入口仍需按产品合同接入 | 需单独核验 | 先定义 Artifact item 合同和安全打开边界，不把 Codex bundle 的预览器当作 BilliardBuddy 的生产依赖 |
| `use-codex-worktrees-*`、`worktrees-settings-page-*` | Worktree 是独立运行资源，可创建、切换、快照、恢复、清理和交接 | `list/create/snapshot/restore/activate/cleanup/handoffWorktree` | 桥已存在 | 在 Thread context 中显示当前 workspace/worktree；恢复/Fork/Review 不能信任 Renderer 传回的 cwd |
| `mcp-settings-*`、`skills-settings-*`、`plugins-settings-*` | MCP、Skill、Plugin 各有设置与启用状态，不是 Composer 的隐形开关 | MCP configure/remove/status/OAuth、Skills、Hooks、Plugin/Marketplace IPC | 桥已存在 | 做设置页和加载/保存错误态；“可列出”不等于“已安装/可运行”，尤其要显示来源和状态 |
| `local-conversation-thread-*` 中的工具/审批相关分支 | 工具调用、输出、审批、追问和失败是不同 Item/事件形态 | `onEvent`、`resolveServerRequest`、`startTurn`、`interruptTurn` | 桥已存在 | 建立统一 Item renderer 和 server request registry；默认 fail-closed，窗口销毁要释放未决请求 |
| `hotkey-window-new-thread-page-*`、`hotkey-window-thread-page-*` | 全局快捷键可打开新任务或当前任务窗口 | Electron window/command IPC、nativeAgent start/resume | 需客户端 | 先做普通窗口内流程，再接快捷键；快捷键不能绕过 workspace、sender 和权限校验 |
| `zh-CN-GwJD95VL.js` | 当前安装包的简体中文词汇覆盖任务、工作目录、工作树、审阅、工具和状态 | BilliardBuddy 自有产品词汇与现有蓝色品牌 | 不直接移植 | 只把它当术语核对表；不复制 ChatGPT 产品名、品牌资产或未确认的中文合同 |

## 客户端状态所有权

```text
Rust Codex Thread Store / App Server
  ├─ Thread、Turn、Item、压缩、审批、工具结果、Fork、Review、恢复
  └─ 通过 thread/*、turn/*、review/* 和 server notification 提供事实
        ↓
Electron Main
  ├─ IPC payload 校验
  ├─ sender 与 Thread/Turn/terminal/search 的窗口所有权
  ├─ 受控 workspace、系统权限、凭据和进程生命周期
  └─ 把属于当前窗口的 notification/server request 转发给 preload
        ↓
preload.nativeAgent
  ├─ 有类型的调用方法
  ├─ 一个可注销的 onEvent
  └─ 不执行 Agent、不保存历史、不接受任意命令或任意 cwd
        ↓
Renderer projection
  ├─ 当前页面、面板、滚动位置、输入框、排队输入和 loading/error
  ├─ 从历史读取和事件增量构建可丢弃的视图模型
  └─ 页面销毁后可重建；重建必须重新 read/resume，而不是恢复私有 Agent 状态
```

Renderer 可以保存 UI 偏好，例如面板开关、草稿和本地滚动位置；不能保存 Thread 历史、Turn 状态、审批决定或工具结果作为第二事实源。

## 推荐施工顺序

### Phase 0：客户端基础边界

目标是让后续页面都使用同一条真实链路。

- 为 `nativeAgent` 建立共享的 preload 类型，移除 `vite-env.d.ts` 对该字段的无类型占位。
- 将 nativeAgent 的输入/返回/事件类型放到 `ts/shared/contracts`，不要从 Renderer 直接 import Electron Main 实现类型。
- 建立一个 `agent` renderer 模块：bridge adapter、事件归并器、投影 store、错误类型和生命周期清理。
- 事件归并器至少区分 `threadId`、`turnId`、server request id、terminal process id 和 fuzzy search session id。
- 先完成“启动 -> 订阅 -> read/resume -> 事件增量 -> 取消订阅”的无 UI smoke，再开始做页面。

停止条件：没有重复 store；事件 listener 可注销；窗口销毁后不会继续收到旧 Thread 的事件；TypeScript 能从 `window.billiardBuddyNative.nativeAgent` 推断方法和返回值。

### Phase 1：App Shell、工作区和 Thread 导航

- 新任务页：工作区、运行位置、模型/权限摘要、创建 Thread。
- 任务列表：分页、搜索、归档、Sections、Goal、父子 Thread 关系。
- 任务页路由：local Thread 先落地；远程任务先显示为未实现/不可用，不制造假数据。
- Shell chrome：侧栏、主内容、右侧面板、窗口状态和全局错误。

停止条件：可以创建 Thread、关闭窗口后重新打开并恢复同一个 Thread；列表和当前页都来自 Rust 读取，不依赖刷新前的 renderer 内存。

### Phase 2：Thread 时间线与 Composer

- `Thread -> Turn -> Item` 三层视图模型。
- 历史分页与实时事件合并，重复通知和乱序通知不能造成重复 Item。
- 用户消息、assistant message、command、file change、reasoning、tool call/result、error、plan 等 Item 的统一 renderer 接口。
- Composer 的草稿、附件/额外上下文、queued message、Steer、暂停和重试。

停止条件：真实 Turn 能显示开始、增量、完成、失败、中断和恢复；刷新页面后 Item 顺序和 Turn 状态仍由 Rust 历史恢复。

### Phase 3：审批、权限与恢复

- server request registry：审批、追问、MCP 表单等请求都按 request id 绑定 Thread/Turn 和当前窗口。
- ask / approve-for-me / full-access、Windows Sandbox readiness/setup、Hook trust 等状态。
- App Server 断开、Electron 窗口销毁、Turn 中断和 provider route 变化时的 fail-closed 展示。

停止条件：没有 UI 按钮可以绕过 `resolveServerRequest`；未决请求不会跨窗口泄漏；恢复后以 `thread/resume` 的 active turn 和历史为准。

### Phase 4：工作区、终端、Diff、Git、Worktree 和 Review

- 文件搜索、集成终端和后台终端。
- Git status/diff/stage/revert/patch/commit/branch；所有路径由 Main 绑定到 Thread workspace。
- Worktree 创建、激活、快照、恢复、清理和 handoff。
- Review 的 inline/detached 结果、Diff 侧栏和 code comment。

停止条件：Renderer 不拥有任意 `spawn`、任意 fs 写入或任意 git cwd；真实 workspace/worktree 变化可以在 Thread、Diff 和 Review 之间一致显示。

### Phase 5：模型、MCP、Skills、Hooks、Plugin、Memory 与设置

- 模型配置继续使用 `window.billiardBuddyNative.models`，不把个人 Key 读取到 Renderer。
- Native Agent 的 provider capability、permission profile、config requirements、client settings、Memory、MCP、Skills、Hooks、Plugin 和 Marketplace 设置。
- 明确区分“可发现”“已保存”“已启用”“正在运行”“需要用户确认”。

停止条件：设置变更经过 Main/Rust 真实返回；active Turn 时禁止改变会破坏路由的设置；错误状态可恢复且不会清空历史。

### Phase 6：Browser、Chrome、Computer Use、Appshot、Artifact、通知和媒体共存

这些能力已有一部分宿主/IPC 边界，但需要独立的用户流程和跨平台/权限证据。顺序上放在基本 Thread/Turn/审批完成之后：

- Appshot 只通过专用 Main action 产生可信/不可信上下文，不允许 Renderer 传入路径或伪造来源。
- Browser、Chrome 和 Computer Use 的 UI 只显示受限能力和连接状态，不把它们变成任意 CDP、任意脚本或任意桌面控制。
- Artifact 预览按明确文件类型和安全打开边界接入；图片/视频继续使用 BilliardBuddy 的 media Sidecar，不并入 Agent Thread Store。
- 桌面通知只投影源生事件，不在 Renderer 另外生成“任务完成”事实。

停止条件：每项能力都有独立的真实生产调用链和权限旅程；未完成的跨平台能力明确显示不可用，不用 bundle 中的按钮或编译产物冒充已交付。

## 建议的 Renderer 目录边界

这是实现边界，不是要求复制 Codex bundle 的目录：

```text
ts/desktop/src/
  agent/
    bridge/       # 只适配 window.billiardBuddyNative.nativeAgent
    state/        # 事件归并、Thread/Turn/Item 投影、生命周期
    shell/        # 侧栏、主内容、右侧面板、全局错误
    threads/      # 列表、搜索、Sections、Goal、归档和 Thread 路由
    conversation/ # 时间线、Item renderer、Composer、队列、审批
    workspace/    # 文件搜索、终端、Diff、Git、Worktree、Review
    settings/     # 模型、MCP、Skills、Hooks、Plugin、Memory
  image-workbench/ # 现有图片工作台，保持独立领域边界
  main.ts          # 只做应用装配，不承载 Agent 状态逻辑
```

不要把 `codex-frontend-reference` 直接 import 到生产代码；也不要把 Agent 逻辑塞进 `image-workbench`。两个领域可以共享窗口、主题和通用 UI primitive，但事实源、错误合同和生命周期必须分开。

## 开工前必须冻结的接口

1. `NativeAgentPreloadBridge`：所有方法的参数、返回值、可取消操作和 `onEvent` 事件联合类型。
2. `NativeAgentEvent`：至少覆盖 Thread/Turn 生命周期、Item 增量、server request、terminal/search 输出和 host/global notification。
3. `AgentProjectionState`：只保存 Renderer 可重建的视图状态，并记录每个 Thread/Turn 的 hydration cursor、last event sequence（如协议提供）和错误边界。
4. `ThreadRoute`：当前 Thread、workspace/worktree 显示信息、父子/Review 关系和侧栏面板，不把 cwd 当作可信身份。
5. `PendingServerRequestView`：request id、Thread/Turn 关系、请求类型、可显示字段、允许的用户响应和过期/拒绝状态。
6. `ItemView`：从源生 Item/notification 映射到 renderer 类型；未知 Item 必须可安全降级显示，不能因为新版本 Item 让整个 Thread 崩溃。

这些接口冻结后再批量写页面。否则最容易出现的返工是：页面先各自调用 preload、各自维护 active turn、各自处理通知，最后形成多个互相矛盾的 Agent 状态。

## 验证门

每个阶段都要同时满足以下证据，不能只看页面出现或孤立单测：

- 类型检查：共享 contract、preload、Main handler 和 Renderer consumer 使用同一组输入/输出类型。
- IPC 检查：payload 校验、sender ownership、Thread workspace 绑定和窗口销毁清理仍然通过。
- Runtime 检查：真实 Rust App Server 的 `thread/start`、`turn/start`、通知、审批、`thread/resume` 和历史读取能完成。
- Renderer 旅程：新建 Thread、发送 Turn、工具审批、拒绝/中断、恢复、Fork/Review、Diff/终端、设置变更至少按阶段实际点击验证。
- 失败行为：App Server 子进程退出、Provider 错误、未知 Item、过期 request、窗口重载、无权限 workspace 都有可见且可恢复的状态。
- 发行验证：安装包中的 App Server、Code Mode Host、插件/宿主资源与 target 平台一致；本机 bundle 参考不进入构建输入。

单元测试、协议脚本、preload 存在和静态页面截图都不能单独证明完整客户端已接线。完成一个阶段后要沿着“Renderer -> preload -> IPC -> Main -> Rust -> notification -> Renderer”走一遍真实链路。

## 逆向参考的更新规则

当本机 Codex 客户端再次更新时：

1. 先读取 `/Applications/ChatGPT.app/Contents/Info.plist` 和 `Contents/Resources/app.asar` 的版本、build、mtime、size、SHA-256。
2. 如果 hash 未变，不重复提取，只在本文件和参考 README 中确认当前版本。
3. 如果 hash 变化，创建新的 `codex-frontend-reference/<version>/` 目录，保留旧版本；不要覆盖历史快照。
4. 重新提取 `raw/`、host bridge、runtime、NOTICE，并刷新 `EXTRACTION_MANIFEST.json`。
5. 重新筛选页面入口和高价值 chunk，生成 `reverse-readable/`；记录 source map 是否存在、文件计数和可读化范围。
6. 只更新“已观察到的 bundle 事实”。任何关于 App Server、权限、跨平台或 BilliardBuddy 生产行为的结论，都要回到 `docs/重构/Agent后端能力证据矩阵.md` 和真实调用链验证。
7. 更新 `/Users/swl/Desktop/billiardbuddy/codex-frontend-reference/README.md` 的当前版本和本文件的快照身份；旧快照不删除。

这套规则保证“客户端更新”带来的是可比较的参考基线，而不是每次都把历史、生产代码和未经验证的 bundle 行为混在一起。

## 相关文件

- [Codex 桌面前端本地逆向参考](/Users/swl/Desktop/billiardbuddy/codex-frontend-reference/README.md)
- [Agent 后端能力证据矩阵](/Users/swl/Desktop/billiardbuddy/docs/重构/Agent后端能力证据矩阵.md)
- [Codex 原生 Agent 路线](/Users/swl/Desktop/billiardbuddy/docs/重构/Codex原生Agent路线.md)
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/preload.ts`
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/main.ts`
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/services/codexNativeAppServer.ts`
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/electron/ipc/channels.ts`
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/src/main.ts`
- `/Users/swl/Desktop/billiardbuddy/ts/desktop/src/vite-env.d.ts`
