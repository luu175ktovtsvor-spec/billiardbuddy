# WorkBuddy 安全设计逆向与落地方案

> 状态：开发决策稿
> 形成日期：2026-07-13
> 逆向对象：本机 `/Applications/WorkBuddy.app` 5.2.5
> 本项目主责模块：`ts/src/permissions`
> 适用范围：桌面 Agent 的权限、沙箱、Electron、loopback transport、凭据、插件、遥测、资产与审计边界

## 0. 结论先行

本项目应吸收 WorkBuddy 的不是一套设置页皮肤，而是三条产品级安全原则：

1. **任务模式、审批权限、沙箱有效性必须分开表达。** “工作模式”不等于“有权做什么”，“完全访问”也不等于“沙箱正在工作”。
2. **高权限必须是可见、可确认、可审计、可撤回的状态。** 开启完全访问要红色风险说明、独立勾选确认和禁用态确认按钮；安全中心只能展示后端实测状态。
3. **Agent 安全不止是权限 + 沙箱 + 文件备份。** Electron renderer、IPC、loopback HTTP/WS、凭据、MCP、插件、技能、遥测、资产下载、更新签名和数据生命周期都是同等级信任边界。

WorkBuddy 也不是安全标准答案。它有值得采用的沙箱策略、系统工具分级、凭据路径硬保护和审计结构，同时也存在宽 CSP、过宽 IPC/本地文件能力、未键控审计哈希、可能包含原始命令内容的遥测、令牌进程参数暴露和更新校验降级等高风险设计。**本项目采用“吸收机制、重写边界、拒绝弱保证”的路线，不逐字搬闭源代码，也不因为大厂来源降低审查标准。**

本项目当前应立刻纠正的 P0 是：

- 沙箱初始化失败不能静默降级明文执行。
- `bypassPermissions` 不能绕过宿主灾难级命令不变量。
- 完全访问不能在 Composer 菜单中单击即生效。
- sidecar 的 REST/WS 不能只靠 loopback 与 CORS，必须有每次启动随机鉴权。
- provider/MCP 凭据不能在安全存储不可用或密钥损坏时静默回退明文/生成新密钥。
- 插件安装后不能默认启用；资产清单不能继续使用 HTTP 和同源未签名哈希。
- 原始崩溃日志不能默认静默上传。

## 1. 证据范围与置信度

### 1.1 样本锁定

| 项 | 值 |
|---|---|
| App | `/Applications/WorkBuddy.app` |
| 版本 | `5.2.5` |
| `app.asar` SHA-256 | `fc144de6e2af209df5378f2bffc83c6d3148cb31dedeaa085c704a83bf48e26b` |
| 桌面包名 | `@genie/workbuddy-desktop` |
| 内置 CLI 包名 | `@genie/agent-cli` |
| CLI 本地版本字段 | `0.0.0`（构建占位值，不能据此判断公开发布版本） |

逆向过程只读取本地安装包：解包 `app.asar`、定位 renderer/main/preload/sidecar/CLI 产物、格式化混淆 bundle、追踪 RPC/进程/配置调用链，再用内置文档与可执行默认值交叉检查。临时解包产物位于 `/tmp`，**没有写入仓库，也没有复制 WorkBuddy 专有实现**。

逆向过程中观察到子进程参数里存在 bearer 类令牌。本文件不记录令牌值，后续任何截图、日志或测试也不得记录。

### 1.2 置信度定义

| 等级 | 含义 |
|---|---|
| A | 可执行代码、进程关系或持久化格式直接证明 |
| B | UI 调用链和后端接口能闭环，但存在构建开关、平台分支或未执行路径 |
| C | 仅文案/内置文档声明，或文档与可执行默认值存在冲突 |

本文所有“WorkBuddy 做了什么”均按上述等级理解。尤其注意：内置文档声称某些 bypass 场景仍保留高危确认，但另一份权限文档又把 bypass 描述为跳过全部审批；CLI 的 `DEFAULT_SANDBOX_CONFIG.enabled` 也是 `false`，而桌面 UI 会另行切换沙箱安全。**因此“默认安全”只能由运行态证明，不能由文档口号推导。**

### 1.3 关键证据锚点

以下行号绑定上述 5.2.5 样本和本次格式化结果，升级版本后必须重新核对：

| 证据 | 样本内逻辑路径/锚点 | 置信度 |
|---|---|---|
| 安全中心读取真实默认表与运行状态 | `renderer/assets/connector-CvFT3fv6.js:58042` | A |
| 完全访问二次确认、勾选、红色按钮 | 同文件 `:113723` 起 | A |
| 沙箱关闭、系统工具、系统授权中文告诫 | `renderer/assets/zh-cn-DvYPcElp.js:2802`、`:3211`、`:4491` | A |
| 审计 JSONL、分段、序列、哈希链、manifest | `main/seed-builtin-plugins.js:31930` 起 | A |
| CLI 沙箱默认配置与凭据路径 deny list | 格式化 CLI `codebuddy.bun.js:139221` 附近 | A |
| Electron 窗口/协议/CSP 处理 | `main/index.js:21980`、`:23037` | A |
| preload 暴露面 | `preload/index.js:56` 起 | A |
| MCP 信任绑定 server 配置指纹 | `main/module.app-server.js:2840` 附近 | A |
| connector loopback 代理鉴权 | 同文件 `:14180` 附近 | A |
| sidecar 每会话 CLI 与 ACP endpoint | `main/sidecar-entry.js:58`、`:564` | A |

## 2. 先定义本项目真正要防什么

本项目是能读取文件、改文件、跑命令、访问网络、调用 MCP、操作桌面和生成媒体的本机 Agent。威胁不能只定义成“模型偶尔误操作”。至少要覆盖：

| 威胁主体 | 典型入口 | 可能后果 |
|---|---|---|
| 提示注入内容 | 网页、仓库 README、文档、MCP 返回值、图片 OCR | 诱导读取凭据、改权限配置、执行下载脚本、外传数据 |
| 恶意/失控模型输出 | Bash/PowerShell、文件工具、computer-use | 批量删除、越界修改、发外部消息、控制其他 App |
| 恶意工作区 | `.mcp.json`、hooks、settings、skills | 启动任意子进程、持久化逃逸、令牌窃取 |
| 恶意插件/技能 | Git 插件、MCP server、hook | 以宿主权限执行、读取全部会话或密钥 |
| 本机其他进程/网页 | loopback HTTP/WS、宽 CORS、端口探测 | 代用户运行 Agent、审批工具、读取会话与文件 |
| renderer XSS/导航劫持 | Markdown、远程页面、CSP、IPC | 调 Electron 原生能力、拿 sidecar 凭据、打开任意本地文件 |
| 供应链攻击 | 资产 manifest、二进制、插件仓库、更新包 | 远程代码执行、持久化替换 |
| 诊断/遥测泄漏 | crash log、命令 stdout/stderr、cwd | 上传门店资料、路径、token、对话内容 |
| 同机事后篡改 | 审计 JSONL、配置、备份 | 删除或重写行为证据，伪造“安全中心正常” |

安全目标不是宣称“绝对安全”，而是：默认最小权限；越权显式；异常失败关闭；可审计；可恢复；不会由一个宽开关同时拆掉全部保护。

## 3. WorkBuddy 的真实安全结构

### 3.1 安全不是一个 PermissionMode

WorkBuddy 把下列维度放在同一安全中心或同一运行链路中：

- 会话权限模式/完全访问。
- 沙箱是否启用及文件、网络策略。
- 文件 allowlist/blocklist。
- 命令 ask/allow 规则。
- Windows 系统级工具策略：`disabled | always_confirm | auto_execute`。
- 删除保护与批量删除阈值。
- macOS 系统授权：完全磁盘、辅助功能、自动化、通知、日历等。
- 审计搜索、导出和保留。
- MCP/连接器/技能的信任与扫描状态。

这解决了常见误导：用户选择“自动执行”不代表 OS 沙箱有效；用户授权“完全磁盘访问”也不代表 Agent 已获准任意删除。

### 3.2 沙箱与升级路径

可执行代码证明 WorkBuddy/CodeBuddy CLI 基于 `@anthropic-ai/sandbox-runtime` 建立文件系统和网络策略，并把凭据目录、shell 配置、产品自身 settings 等放入 deny list。它还单独识别 WSL、`wmic`、`sc`、`reg`、`schtasks` 等能绕过普通沙箱语义的系统工具。

值得采用的机制：

1. 沙箱内的安全命令可以低打扰自动执行。
2. 命令观察到沙箱阻断后，才进入一次性升级/修改策略流程。
3. 凭据路径和产品安全配置是硬保护，不能被宽泛 allowlist 轻易覆盖。
4. 文件、命令、网络、Unix socket 和系统级工具分开配置。
5. 删除走 safe-delete 语义，批量删除有独立阈值；5.2.5 中观察到默认阈值为 50。

不能照搬的部分：

- CLI 默认对象里的 `enabled:false`、`allowUnsandboxedCommands:true` 与产品“沙箱默认安全”的文案不构成同一保证，桌面宿主必须显式下发并回读运行态。
- 宽域名 allowlist 不能阻止域前置、代理隧道或被信任站点转发数据。
- 允许 Docker socket、宽 Unix socket 或可写 `$PATH` 目录，效果等同宿主逃逸。
- “沙箱外重试”不能只凭 permission mode 自动批准，必须再次评估真实命令和失败原因。

### 3.3 完全访问的风险交互

WorkBuddy 的完全访问入口不是普通下拉项：

- 高风险态使用红色开关和错误图标。
- 打开前弹二次确认。
- 文案说明会自动执行命令、修改或删除文件等后果。
- 用户必须勾选“已理解风险”后确认按钮才可用。
- 关闭完全访问不需要额外阻力。

这是应直接吸收的产品模式，但本项目要增加两个约束：

1. 确认只授权“减少一般审批”，不取消宿主灾难级不变量。
2. 安全状态变化必须由后端返回成功后再更新 UI，不能前端乐观假装生效。

### 3.4 审计链路

WorkBuddy 审计实现不是普通 `debug.log`：

- JSONL 事件。
- 单调 sequence。
- 每条记录含前一条哈希，跨分段延续。
- 日期/大小分段，默认单段上限 50 MiB。
- 独立 manifest 记录分段摘要、条目数和文件 SHA-256。
- spool 导入、保留清理 tombstone、反向查询、搜索和导出。
- 导出时国际化描述与字段脱敏。

它能发现普通损坏、删行、换序和部分分段丢失，但哈希是普通 SHA-256，本机攻击者可以重算整条链。**本项目如果采用，应使用 OS vault 中独立审计密钥做 HMAC 链，并把周期锚点写到不同权限边界；不能把 WorkBuddy 的“可校验”误写成“不可篡改”。**

### 3.5 loopback、sidecar 与 MCP 信任

WorkBuddy 的本地连接器代理具备以下值得采用的边界：

- 绑定 loopback 和临时端口。
- bearer 鉴权。
- 检查 `Host` 和 `Origin`。
- Unix domain socket 运行目录使用仅当前用户可访问的权限。
- MCP 信任不仅关联 server 名称，还关联配置内容哈希；配置变化后旧信任失效。

需要修正的部分：

- bearer 不应出现在子进程命令行参数，避免被进程列表、崩溃报告和诊断采集。
- 令牌应通过继承 pipe、权限受限文件描述符或环境传递；环境也必须从日志与子孙进程白名单中剥离。
- MCP 的 URL/command/args/env 任一安全相关字段变化，都要改变配置指纹。

### 3.6 Electron、凭据、插件和更新

WorkBuddy 有 `contextIsolation`、sandboxed renderer、多 preload 和本地协议等宿主结构，但同时暴露了不应借鉴的能力：

- 类 `__datongIpc` 的通用 send/invoke/on 表面过宽。
- renderer 可请求任意本地文件协议。
- CSP 包含 `unsafe-inline`、`unsafe-eval` 和较宽网络源。
- 技能扫描可能上传文件，并提供“跳过扫描继续安装”。
- 本地 master key 备份弱于 OS vault。
- 更新路径存在哈希绕过/签名身份钉住不足的迹象。
- macOS entitlement 偏宽且 library validation 关闭扩大了动态代码风险。

这些是反例，不是“大厂最佳实践”。

## 4. 设置页告诫应怎样落到本项目

### 4.1 必须展示的不是说明书，而是当前事实

安全中心首页建议只展示可操作状态：

| 区域 | 后端事实 | 用户动作 | 禁止做法 |
|---|---|---|---|
| 沙箱 | configured/effective/backend/degraded/reason | 修复、重试、查看限制 | 写死“已开启”徽标 |
| 权限 | 当前会话模式、规则来源、硬不变量 | 切换、撤销会话授权 | 把模式等同安全等级 |
| 文件 | 可写根、硬阻止路径、安全删除、阈值 | 管理额外目录 | 展示并不存在的全盘保护 |
| 网络 | 默认策略、临时放行域、外联记录 | 允许一次/撤销 | 用 CORS 冒充鉴权 |
| 系统工具 | disabled/always_confirm/auto_execute | 独立切换 | 跟随完全访问自动开启 |
| OS 授权 | macOS/Windows 实际权限 | 跳系统设置 | 只显示请求过而非真实状态 |
| 插件/MCP | 来源、指纹、扫描、信任、权限 | 隔离、信任、停用 | 安装后默认启用 |
| 审计 | 是否工作、最后事件、链验证 | 搜索、导出 | 仅放 debug log 下载按钮 |
| 遥测 | 关闭/元数据/显式诊断 | 查看与撤销 | 默认上传原始日志 |
| 更新/资产 | 签名者、版本、校验、回滚点 | 检查更新 | “有 SHA-256”就称安全 |

### 4.2 风险告诫文案规则

- 说明**会发生什么**，而不是只写“高风险”。
- 说明保护被关闭后还剩什么，且内容由后端能力生成。
- 开启高权限需要额外动作；关闭高权限一步完成。
- 确认框不得预勾选，不得用回车误触默认确认。
- 灾难级命令确认显示规范化命令、cwd、影响路径、是否越出工作区和是否可恢复。
- “允许一次”“本会话允许”“永久允许”必须分开；涉及凭据、系统配置、删除和外发时不得提供永久宽放行。

## 5. 本项目现状审计

### 5.1 已经做对的基础

| 能力 | 当前证据 | 判断 |
|---|---|---|
| 五档权限与规则来源 | `ts/src/permissions/types.ts`、`permissionsSettings.ts` | 可作为策略内核，不重写 |
| HMAC 审批 token | `ts/src/permissions/approval.ts` | 正确；进程随机 fallback 令牌重启失效 |
| 敏感路径/危险命令/工作区边界 | `ts/src/permissions/*`、`ts/src/tools/dangerousCommand.ts`、`ts/src/workspace/*` | 基础较强，需补宿主不变量 |
| MCP 工具审批、workspace trust | `ts/src/mcp/mcpTrust.ts`、server trust wiring | 有门，但信任粒度不足 |
| 文件快照与 restore | `ts/src/tools/fileHistory.ts` 和文件编辑工具 | 对文件工具有效，不等于所有写入可回滚 |
| Electron 显式 preload API | `ts/desktop/electron/preload.ts` | 比通用 ipcRenderer 安全 |
| provider 凭据加密 | `credentialKey.ts` + `credentialCipher.ts` | 正常路径使用 safeStorage + AES-256-GCM |

### 5.2 当前缺口与风险等级

| 等级 | 事实 | 代码证据 | 后果 |
|---|---|---|---|
| P0 | 沙箱初始化/包裹异常后 `degraded=true` 并返回 `null` 明文执行 | `ts/src/sandbox/sandbox.ts:42-69` | 用户以为有沙箱，实际宿主执行 |
| P0 | `fullDiskAccess` 让 OS 沙箱不激活 | `sandbox.ts:29-35` | 扩目录授权同时拆掉命令隔离 |
| P0 | Windows Job Object 尚为占位，返回明文执行 | `ts/src/sandbox/windowsLauncher.ts:14-24` | Windows 无 OS 文件系统围栏 |
| P0 | bypass 在危险命令判定前直接 allow | `ts/src/permissions/resolve.ts:223-230` | 完全访问可执行删根/格式化等命令 |
| P0 | Composer 单击即切换完全访问 | `ts/desktop/renderer-react/src/components/chat/Composer.tsx:90-115` | 无风险确认与独立确认凭据 |
| P0 | sidecar REST/WS 无启动级鉴权；CORS 不是鉴权 | `ts/src/server/index.ts:3382-3398`、`:4944-5027` | 本机网页/进程可尝试运行、回放、审批 |
| P0 | renderer CSP 允许 `unsafe-inline`、`unsafe-eval` | `ts/desktop/renderer-react/index.html:11-12` | renderer 注入后的宿主攻击面扩大 |
| P0 | top-level navigation 未见同等阻断；路径 IPC 仅做非空/长度检查 | `navigationGuards.ts`、`main.ts:339-347` | renderer 可请求打开任意绝对路径 |
| P0 | safeStorage 不可用时凭据回退明文；旧 DEK 损坏时生成新 DEK | `credentialKey.ts:32-63`、`credentialCipher.ts` | 静默降级或使旧密文不可恢复 |
| P0 | MCP OAuth token 是 mode 0600 的明文 JSON | `ts/src/mcp/oauth.ts:88-145` | 同用户上下文泄露后直接可用 |
| P0 | Git 插件 clone 后默认 enabled，插件 MCP/hook 视为 app trusted | `ts/src/plugins/pluginLoader.ts:82-125`、`:191-222` | 远程仓库代码立即进入高权限路径 |
| P0 | 默认资产 manifest 是 HTTP，hash 与 payload 同一不可信来源 | `ts/src/assets/assetManager.ts:31-32`、`:311-329` | MITM 可同时替换二进制与哈希 |
| P1 | MCP trust 仅绑 workspace root；explicit config 绕过信任 | `ts/src/mcp/mcpTrust.ts:68-81` | 配置变化后旧信任仍有效 |
| P1 | 没有安全审计子系统 | 当前只有 debug/crash/session event | 无统一审批/越权/外联/策略变更证据 |
| P1 | crash log 默认静默上传，缺用户开关 | `ts/src/server/services/telemetry.ts:7-16`、`:70-129` | 脱敏遗漏会把本机内容发出 |
| P1 | 文件备份是工具级且存在跳过/失败路径，shell 修改不覆盖 | `ts/src/tools/fileHistory.ts:103-133` 及调用点 | “改文件都可回滚”并不成立 |
| P1 | 无一等 safe-delete 与批量阈值 | `ts/src/tools/` 无 delete/trash 工具 | 删除主要落在 shell，恢复与统计不完整 |
| P1 | `desktop-host.ts` 是手写接口，边界不做 Zod parse | `ts/shared/contracts/desktop-host.ts` | main/preload/renderer 可能契约漂移 |
| 发布门 | 自动更新未接、macOS/Windows 包未签名 | `ts/electron-builder.yml`、当前依赖 | 无可信发布身份和回滚链 |

### 5.3 必须修正的项目口径

下列当前文档表述不能继续当安全保证：

- “全本地”：实际是本地优先执行，但模型、媒体、遥测、资产和部分连接器依赖网络服务。
- “沙箱 + 备份可回滚”：沙箱会静默降级，Windows 尚无 OS 围栏，shell 写入绕过 file history。
- “完全访问按 cc 放行危险命令”：cc-haha 可以作为 harness 行为参考，但产品宿主必须额外保留灾难级不变量。
- “CORS 仅允许 localhost”：它只限制浏览器读取响应，不证明请求来自本应用。

## 6. 本项目目标安全模型

### 6.1 六条不可被设置关闭的不变量

1. renderer、任意网页和本机其他进程没有启动随机凭据时，不能调用 sidecar 的非健康接口或 WS。
2. 沙箱状态不确定/降级时，不能把需要沙箱的命令按明文自动执行。
3. 凭据、shell 启动文件、产品权限配置、插件信任库不能被宽 allow rule 自动写入。
4. 格式化磁盘、删除根/home、改引导/账号/安全策略等宿主灾难级动作，即使 full access 也必须硬拒或独立强确认。
5. 插件、MCP、hook、技能的执行身份或配置哈希变化后，旧信任无效。
6. 未签名或签名身份不匹配的资产/更新不能执行；校验失败不能提供“仍然安装”。

### 6.2 共享契约

新增 `ts/shared/contracts/security.ts`，全部由 Zod Schema 推导类型并在 REST/IPC/renderer 边界 parse。核心结构：

```ts
SecurityRuntimeStateSchema = z.object({
  schemaVersion: z.literal(1),
  observedAt: z.string().datetime(),
  overall: z.enum(['healthy', 'degraded', 'unsafe', 'unsupported']),
  sandbox: SandboxRuntimeStateSchema,
  permissions: PermissionRuntimeStateSchema,
  transport: LocalTransportStateSchema,
  secrets: SecretStorageStateSchema,
  extensions: ExtensionTrustStateSchema,
  audit: AuditRuntimeStateSchema,
  supplyChain: SupplyChainStateSchema,
})
```

必须区分：

- `configured`：用户想要的策略。
- `effective`：后端当前确认已生效。
- `supported`：平台是否具备实现。
- `degradedReason`：为何没生效。
- `policyRevision`：防止旧页面覆盖新配置。

接口建议：

| 接口 | 契约 | 语义 |
|---|---|---|
| `GET /api/v1/security/state` | `SecurityRuntimeState` | 读取真实状态，不触发授权弹窗 |
| `PUT /api/v1/security/policy` | `SecurityPolicyUpdate` | 带 revision，原子应用后回读 |
| `POST /api/v1/security/full-access/ack` | `FullAccessAcknowledgement` | 短时一次性确认凭据，不落明文文案 |
| `GET /api/v1/security/audit` | page/cursor filter | 查询脱敏事件 |
| `POST /api/v1/security/audit/export` | export request/result | 本地导出，默认脱敏 |

### 6.3 目标调用链

```text
SettingsPage / Composer
  -> Zod parse SecurityRuntimeState
  -> 带启动 token 的 REST/WS
  -> security policy service
  -> permission resolver + sandbox health + extension trust
  -> tool / Electron host 执行
  -> HMAC audit append + file history / trash
  -> runtime state 聚合回读
```

UI 永远不自行推断“安全”。如果后端返回 sandbox `configured=true/effective=false`，页面必须显示降级原因，自动执行策略同时收紧。

## 7. 开发落地顺序

### P0-1：沙箱与完全访问失败关闭

**目标文件**

- `ts/src/sandbox/sandbox.ts`
- `ts/src/sandbox/osSandbox.ts`
- `ts/src/sandbox/windowsLauncher.ts`
- `ts/src/permissions/resolve.ts`
- `ts/src/permissions/types.ts`
- `ts/desktop/renderer-react/src/components/chat/Composer.tsx`
- `ts/desktop/renderer-react/src/pages/SettingsPage.tsx`
- 新 `ts/shared/contracts/security.ts`

**实现决策**

- `Sandbox.wrapCommand` 返回显式 discriminated union：`wrapped | unavailable | disabled`，禁止用 `null` 同时表示三种状态。
- 初始化失败时将 turn 标为 degraded；需要 sandbox 的命令退为 ask，`dontAsk` 下 deny，不能 plain spawn。
- `fullDiskAccess` 只扩大明确授权根，不自动关闭 OS sandbox；确实无法兼容时显示 unsupported 并收紧执行。
- Windows 真沙箱未完成前，安全中心明确 `unsupported`；高风险和工作区外命令不得自动执行。
- `fatal/forceConfirm/requiresUserInteraction/hostCatastrophic` 在 bypass 分支之前。
- Composer 开启 full access 走二次确认；后端 ack 成功才切换。

**验收**

- 注入 `ensureInitialized`/`wrapArgv` 失败，断言命令没有 spawn。
- bypass 下 `rm -rf /`、`format C:`、改系统账号/安全策略不能静默 allow。
- full access 确认未勾选时按钮不可用；取消后模式不变；后端失败时 UI 不变。
- UI 同时展示 permission mode 与 sandbox effective state。

**回滚**：保留旧配置读取兼容，但不保留 fail-open 行为开关。

### P0-2：loopback 与 Electron 宿主边界

**目标文件**

- `ts/desktop/electron/main.ts`
- `ts/desktop/electron/preload.ts`
- `ts/shared/contracts/desktop-host.ts`（迁移为 Zod 契约）
- `ts/src/server/index.ts`
- `ts/desktop/renderer-react/src/api/client.ts`
- `ts/desktop/renderer-react/src/api/websocket.ts`
- `ts/desktop/renderer-react/src/desktopRuntime.ts`
- `ts/desktop/electron/services/navigationGuards.ts`
- `ts/desktop/renderer-react/index.html`

**实现决策**

- Electron 每次启动生成 256-bit 随机 sidecar token，经环境注入 sidecar，不进 argv、不进日志。
- `runtime.getServerUrl` 改为 `getServerConnection(): {baseUrl, token}`；renderer 仅内存保存。
- 除 `/health` 最小信息外，REST 必须 `Authorization: Bearer`；WS upgrade 同样校验。
- 同时校验 `Host`、`Origin` 和方法；CORS 继续保留但不再承担鉴权。
- 限制 top-level navigation；renderer 不允许离开 app origin/file entry。
- `openPath/revealPath` 参数必须通过 Schema，并限定为工作区、用户显式选择文件或本应用产物。
- 生产 CSP 移除 `unsafe-eval`，逐步用 nonce/hash 去除 `unsafe-inline`。

**验收**

- 无 token、错 token、错 Host/Origin 的 REST 和 WS 都失败。
- token 不出现在 `ps`、debug log、crash log、audit export。
- 外部网页不能导航主窗口或调用任意路径 IPC。
- React、vanilla 过渡入口都能正常启动；旧无 token 客户端只在测试显式兼容开关下可用，生产无兼容旁路。

### P0-3：凭据与扩展供应链

**目标文件**

- `ts/desktop/electron/services/credentialKey.ts`
- `ts/src/server/services/credentialCipher.ts`
- `ts/src/mcp/oauth.ts`
- `ts/src/mcp/mcpTrust.ts`
- `ts/src/plugins/pluginLoader.ts`
- `ts/src/assets/assetManager.ts`
- `ts/electron-builder.yml`

**实现决策**

- safeStorage 不可用时禁止新增长期凭据，允许内存会话凭据；不得明文落盘。
- DEK 文件存在但无法解密时进入 recovery 状态，不生成新 DEK 覆盖事实。
- MCP OAuth token 通过同一 OS-vault-backed cipher 加密。
- MCP 信任键包含规范化 `command/url/args/env-key-names/transport` 的配置哈希；配置变化即重新确认。
- 插件 clone 到 quarantine，manifest 默认 `enabled:false`；本地静态扫描、来源展示、用户确认后才原子激活。
- 禁止“跳过高风险扫描并启用”。技能扫描默认本地，上传必须单独显式同意。
- manifest 强制 HTTPS 并验 Ed25519 签名；payload 再验 SHA-256；签名公钥/签名者钉在安装包内。
- 可执行资产采用 staging -> verify -> atomic promote，保留上一版本回滚。

**验收**

- safeStorage unavailable、DEK corruption、旧密文三种路径均不丢数据、不明文写入。
- 修改 MCP args/env 后旧 trust 失效。
- 新安装插件不能贡献 skill/MCP/hook，直到扫描和确认完成。
- HTTP manifest、未知 signer、同源伪 hash、zip traversal、签名正确但 payload hash 错全部拒绝。

### P1-1：安全审计与真实安全中心

**目标文件**

- 新 `ts/src/security/audit/*`
- 新 `ts/src/server/routes/securityRoutes.ts`
- `ts/src/permissions/resolve.ts`
- `ts/src/harness/loop.ts`
- `ts/src/server/index.ts`
- `ts/desktop/renderer-react/src/pages/SettingsPage.tsx`
- `ts/shared/contracts/security.ts`

**审计事件最小集合**

- permission decision、approval issue/approve/reject/expire。
- sandbox blocked/degraded/escalated。
- policy/rule/trust/full-access change。
- workspace/additional-directory change。
- network outreach、MCP connect/tool call、plugin/skill/hook activation。
- credential create/update/delete（只记引用，不记值）。
- destructive/safe-delete/restore。
- asset/update signer verification。

**存储决策**

- JSONL、sequence、segment、manifest、retention、cursor query。
- 条目使用 HMAC-SHA-256 链；审计 key 与 provider DEK 分离，存在 OS vault。
- 审计 payload 默认只存命令指纹 + 脱敏摘要；原始 stdout/stderr 不进审计。
- 每日/每 N 条把链头写入独立权限文件；未来可选远端只上传链头，不上传内容。
- 策略变更必须审计自身，审计失败时高权限变更失败关闭。

**验收**

- 删行、换序、改字段、换分段能被验证器发现。
- 没有 audit key 时明确 degraded，不能显示“审计正常”。
- 搜索/导出不泄露 token、home 绝对路径和 provider 身份。

### P1-2：安全删除与完整恢复口径

**目标文件**

- 新 `ts/src/tools/safeDeleteTool.ts`
- `ts/src/tools/fileHistory.ts`
- `ts/src/tools/runCommandTool.ts`
- `ts/src/tools/dangerousCommand.ts`
- 对应 registry、契约和 UI diff/restore 消费者

**实现决策**

- 一等 `safe_delete` 工具优先移入 app trash/history，不直接 unlink。
- 默认批量阈值 50 只是初始策略，不是安全常数；目录、glob、递归、动态 shell 展开单独分级。
- shell 删除命令无法可靠重写时进入强确认，并明确“此操作不受 file history 完整保护”。
- file history 记录 skipped/failed 必须反馈到审批与最终结果，不能继续宣称可回滚。
- 大文件/二进制采用容量配额和回收策略，不能因为超限静默无备份。

**验收**

- 单文件、目录、glob、symlink、工作区外、根/home/盘符根、超过阈值全部有确定判定。
- safe delete 可恢复；永久清空是独立 destructive action。
- shell 修改在 UI 中明确标注“无保证”或由快照层覆盖。

### P1-3：遥测最小化

**目标文件**

- `ts/src/server/services/telemetry.ts`
- `ts/desktop/renderer-react/src/pages/SettingsPage.tsx`
- `ts/shared/contracts/security.ts`

**实现决策**

- 默认关闭原始诊断上传；默认允许的只有不含内容的本地统计。
- 远端元数据遥测需清晰开关；原始 crash log 每次显式预览与同意。
- 命令、stdout/stderr、cwd、blocked path、对话、门店资料不得进入默认 payload。
- 发送前 Schema 白名单 + redaction + payload snapshot 测试；失败不影响主任务。

### P2：进程隔离、Windows 与发布成熟度

- 评估把高风险 command/MCP/plugin 执行放入每会话 worker/子进程，不必照搬 WorkBuddy 的全会话 CLI 进程。
- Windows 接入真实 AppContainer/受限 token/Job Object 组合；在此之前不宣称 OS sandbox。
- macOS/Windows 安装包签名、notarization、signer pinning、自动更新 staged rollout 与 rollback。
- 将 Security Center 状态和质量门接入发布 smoke；签名、资产、公钥、沙箱 backend 任一异常阻断发布。

## 8. 采用、修改、拒绝清单

| WorkBuddy 设计 | 决策 | 本项目落法 |
|---|---|---|
| 权限、沙箱、系统工具分层 | 采用 | 独立状态与策略契约 |
| 完全访问红色二次确认 | 采用并增强 | ack + 宿主灾难级不变量 |
| 安全中心回读真实默认表/状态 | 采用 | 后端聚合 `SecurityRuntimeState` |
| sandbox-first、阻断后升级 | 采用 | explicit degraded + allow once |
| 系统工具三档 | 采用 | 独立 policy，不跟随 full access |
| 凭据路径硬 blocklist | 采用 | 规则不可被宽 allow 覆盖 |
| safe-delete + 批量阈值 | 采用 | 一等工具 + 恢复 + shell 告警 |
| JSONL 分段审计 | 修改后采用 | keyed HMAC + 独立锚点 |
| MCP 配置哈希信任 | 采用并扩展 | 安全相关字段全入规范化哈希 |
| connector bearer + Host/Origin | 采用并修正 | token 不进 argv，REST/WS 全覆盖 |
| 通用 renderer IPC | 拒绝 | 保持窄 preload + Zod parse |
| 任意本地文件协议 | 拒绝 | capability/path grant |
| `unsafe-eval` 与宽 CSP | 拒绝 | 生产 nonce/hash CSP |
| 原始命令/输出遥测 | 拒绝 | 元数据默认，内容逐次同意 |
| 跳过技能扫描继续安装 | 拒绝 | quarantine 未通过就不能激活 |
| 未键控审计哈希当防篡改 | 拒绝 | HMAC key 与 provider key 分离 |
| 装饰性“安全网关/加密”徽标 | 拒绝 | 只显示 runtime evidence |
| 本地 master-key 备份 | 拒绝 | OS vault；损坏进入 recovery |
| 更新 hash bypass/弱 signer pinning | 拒绝 | 无可信签名就不执行 |

## 9. 验证总清单与完成定义

每个实施波次必须同时通过：

1. 单元：permission/sandbox/path/credential/trust/audit/supply-chain 的失败路径。
2. 契约：所有 REST、WS、IPC 均由 `ts/shared/contracts` Zod Schema 生产与解析。
3. 后端 E2E：真 sidecar、错误 token、sandbox failure、审批、文件效果、审计链。
4. 桌面 E2E：完全访问确认、安全中心降级态、导航守卫、IPC 路径能力。
5. 运行证据：macOS 与 Windows 分别展示 sandbox backend；unsupported 不得显示 healthy。
6. 泄密检查：进程参数、env dump、debug/crash/audit/export、测试快照无真实 token。
7. 供应链：离线、MITM、未知 signer、回滚、断电中断安装。
8. 文档：修正 `CLAUDE.md`/`ts/CLAUDE.md` 中“全本地、备份保证、完全访问放行灾难命令”的过度表述。
9. 机械门：`bash scripts/quality_gate.sh`。

以下条件全部满足，才可把安全中心称为“已落地”：

- UI 状态来自运行时，不是常量。
- 任何 degraded 都联动自动执行收紧。
- full access 不绕过六条不变量。
- sidecar 非健康接口全部鉴权。
- 凭据无明文 fallback。
- 插件/资产/更新有可信来源与回滚。
- 审计可验证且默认不收集敏感内容。

## 10. 剩余风险

- 任何能执行用户权限命令的本机 Agent 都不能仅靠应用层规则消除风险；管理员/root、辅助功能、Docker socket 等能力会显著削弱沙箱。
- renderer token 能阻挡其他网页/普通本机进程的直接调用，不能拯救已完全攻陷的 renderer；因此 CSP、导航和 IPC 同样是 P0。
- HMAC 审计能提高篡改成本，无法对抗同时取得应用数据和 OS vault 的同用户攻击者；远端锚点只能作为可选增强。
- 每会话进程隔离降低共享状态与崩溃半径，但不会自动形成安全边界；没有 OS 级权限隔离的子进程仍拥有同一用户权限。
- WorkBuddy 5.2.5 只是一个时间点。升级后证据和结论必须按新包 hash 重新验证，不能把本文件当永久事实。
