# Claude Code 2.1.207 与 cc-haha 差异逆向立项

> 状态：已立项，已完成基线和首轮 CLI 差异
> 日期：2026-07-13
> 官方对象：`/Users/swl/.local/share/claude/versions/2.1.207`
> 候选源码映射：`/Users/swl/Desktop/cc-haha-ref`

## 0. 直接结论

1. **本机 Claude Code 2.1.207 不是“整个源码加密到不可读”。** 它是签名的 arm64 Mach-O，应用代码以 Bun standalone payload 形式放在 `__BUN/__bun` 段。Mach-O 无 `LC_ENCRYPTION_INFO`/`cryptid`，可直接搜到大量提示词、CLI 文案、模块标识符、内部构建路径和压缩后 JavaScript。
2. **真正的障碍是打包、minify、tree-shaking、部分符号删除和 feature gate，不是密码学加密。** 变量名缩短、模块边界被合并，且没有可直接使用的完整 source map，所以不适合从第一字节开始反编译。
3. **`cc-haha-ref` 规模约 61 万行，确实不能人工逐行比。** 应先对比外部契约和模块指纹，只对出现重要差异的模块定点还原。
4. **`cc-haha-ref` 与官方 2.1.207 具有强同源/强映射证据，但当前不能称为“2.1.207 逐文件完整源码”。** 它可能是其他时点的源码快照、内部/外部分支混合物、带自定义实现的衍生版，也可能有因构建开关导致的表面差异。

## 1. 可复现基线

### 1.1 官方二进制

| 项 | 值 |
|---|---|
| 版本 | `2.1.207 (Claude Code)` |
| 文件类型 | Mach-O 64-bit executable arm64 |
| 大小 | 约 230 MB |
| SHA-256 | `1397a062c6889675055e3314dd956376ac51262a7734ad9e819c26975d71547a` |
| 签名 | Developer ID Application: Anthropic PBC (`Q6L2SF6YDW`) |
| 宿主系统下限 | macOS 13.0 |
| `__TEXT` | 61,603,840 bytes |
| `__BUN/__bun` | 175,854,489 bytes |
| Mach-O 加密命令 | 未发现 |
| 可见字符串 | `strings -n 20` 约 172,491 条 |

可直接在官方二进制命中的特征包括：

- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
- `Only use emojis if the user explicitly requests it`
- `Do not use a colon before tool calls`
- `formatCommandsWithinBudget`
- `TaskCreate` / `EnterPlanMode` / `PermissionResult`
- `/home/runner/work/claude-cli-internal/claude-cli-internal/...` 内部构建路径
- 压缩后的 JavaScript 函数与内置 skill/prompt 文本

### 1.2 cc-haha 候选源码

| 项 | 值 |
|---|---|
| Git commit | `d318b1b49213b9a0445f82681876003580e41263` |
| commit 时间 | `2026-07-07T23:28:26+08:00` |
| 本地包版本 | `999.0.0-local` |
| TS/TSX 文件 | 2,331 |
| TS/TSX 行数 | 610,847 |
| `src/` 大小 | 约 38 MB |
| 最大模块群 | `utils` / `components` / `commands` / `tools` / `services` / `server` |
| 声明许可 | 本地 `LICENSE` 声明可使用、修改、分发和商业衍生 |

### 1.3 强映射指纹

首轮启发式指纹：从非测试 TS/TSX 中提取长度至少 16 的 `function/class/const` 名，再在官方二进制中做精确字面匹配。

| 指标 | 结果 |
|---|---|
| cc-haha 唯一长标识符 | 11,986 |
| 官方 2.1.207 原样命中 | 1,859 |
| 典型命中 | 权限、prompt cache、memory、compact、Agent、skill、hook、worktree、MCP、session |

这不是“代码相同率 15.5%”：minify 会删除/缩短大量私有标识符，通用名也可能偶然命中。它的用途是证明两者存在大规模可定位的模块对应，为后续按模块取证排序。

## 2. 首轮确定差异

### 2.1 顶层 CLI

官方 2.1.207 相对当前 `claude-haha --help` 新增/公开的选项：

- `--ax-screen-reader`
- `--bg` / `--background`
- `--brief`
- `--exclude-dynamic-system-prompt-sections`
- `--plugin-url`
- `--prompt-suggestions`
- `--remote-control`
- `--remote-control-session-name-prefix`
- `--safe-mode`

`cc-haha` 当前帮助中有、官方 2.1.207 帮助中没有：

- `--mcp-debug`（已标注 deprecated）
- `--no-computer-use`

官方新增/公开的顶层子命令：

- `auto-mode`
- `gateway`
- `project`
- `ultrareview`

其他明确变化：

- `--effort` 从 `low/medium/high/max` 扩展为 `low/medium/high/xhigh/max`。
- `--permission-mode` 从 `default` 为主的五档变为包含 `auto/manual`、不再公开 `default` 的六档。
- fallback model 从单个值扩展为按顺序尝试的多模型列表，并在每个用户回合重试主模型。
- `--plugin-dir` 支持 `.zip`，并新增远程 plugin zip 入口。
- `--print` 的信任和无效 settings 处理说明发生变化。

### 2.2 子系统变化

| 子系统 | cc-haha 当前可见行为 | 官方 2.1.207 可见行为 |
|---|---|---|
| `agents` | 列出已配置 agent | 管理/派发后台会话，支持 JSON、cwd、model、effort、permission、MCP、plugin 等入参 |
| `plugin` | install/list/enable/disable/update/validate/marketplace | 新增 `details`、`eval`、`init`、`prune`、`tag` |
| `mcp` | add/get/list/remove/serve 等 | 新增 `login/logout`；未批准 `.mcp.json` 服务器改为 pending 且不连接 |
| `auto-mode` | 源码有实现、本地帮助未公开 | 顶层公开，有 `config/defaults/critique` |
| `project` | 顶层帮助不可见 | 新增项目状态 `purge` |
| `gateway` | 顶层帮助不可见 | 公开企业 auth/telemetry gateway |

### 2.3 不能把帮助差异直接当源码差异

已确认的反例：

- `--brief` 在 `cc-haha-ref/src/main.tsx` 中已注册。
- `--background` 在 `entrypoints/cli.tsx` 中受 `BG_SESSIONS` feature gate 控制。
- `--remote-control` 在 `main.tsx` 中存在，但 `hideHelp()` 隐藏。
- `auto-mode` 的 handler 和命令注册都在源码中，本地构建未对外显示。

因此每个差异必须归入下列五类之一：

| 类别 | 含义 |
|---|---|
| A 官方新增 | 2.1.207 二进制有，cc-haha 源码确认无 |
| B 构建/开关差异 | cc-haha 源码有，但当前本地构建未公开或 DCE |
| C cc-haha 自定义 | cc-haha 有，官方 2.1.207 契约中无 |
| D 行为对齐 | 文案、Schema、副作用和边界测试一致 |
| E 未知 | 只有单一证据或需要真实运行时才能判定 |

## 3. 为什么不逐行分析 61 万行

逐行分析有三个根本问题：

1. 官方二进制已合并模块并缩短标识符，不存在稳定的“官方第 N 行”可供对齐。
2. 大部分代码是 UI、依赖、平台适配和内部功能，与本项目要迁移的 kernel 行为无关。
3. 行数相同不等于行为相同；一条权限分支或一个失败降级的差异，比数万行 UI 相同更重要。

本项目改用下列漏斗：

```text
版本/哈希基线
  -> CLI/配置/持久化外部面
  -> 提示词/工具 Schema/事件契约
  -> 隔离环境黑盒差分测试
  -> 字符串/长标识符模块指纹
  -> 只对重要不一致项提取二进制附近 minified JS
  -> 回到 cc-haha 候选文件做定点语义对照
  -> 形成本项目的迁移/拒绝/延后决策
```

## 4. 逆向工作包

### R0 基线与工具链（已完成首轮）

- 固定官方 binary 版本、SHA-256、签名、Mach-O 段和 cc-haha commit。
- 记录官方/候选源码规模。
- 建立差异分类 A-E。
- 默认禁用真实账号、真实 API 调用和外部副作用。

### R1 CLI、设置与配置 Schema

- 比较顶层/子命令 help、exit code、默认值和错误文案。
- 对比 settings 层级、无效配置、safe/bare mode、feature gate 与环境变量。
- 输出《CLI/设置差异矩阵》。

### R2 系统提示词、工具 Schema 与模型适配

- 从官方 binary 搜索定位长提示词、tool name、JSON Schema 字段和模型分支。
- 以 cc-haha 源码为候选映射，按 section/tool 生成“存在/文案变更/条件变更/未找到”矩阵。
- 单独跟踪英文内核提示词、动态 prompt 分段、prompt cache 边界和输出语言层。

### R3 权限、沙箱和危险动作

- 对比 permission mode、allow/ask/deny 顺序、路径归一化和命令解析。
- 检查 `auto/manual` 相对 `default`、`bypassPermissions` 的新语义。
- 使用无网络、临时 HOME/工作区做只读或可回收差分测试。
- 安全结论输出到 WorkBuddy/本项目安全方案，不因“官方这么做”自动采纳。

### R4 Agent loop、context、memory、tasks 与 hooks

- stream/content block/tool pairing/resume/replay。
- microcompact/自动压缩/超长工具结果/prompt cache。
- AutoMem/CLAUDE.md/相关记忆/历史搜索。
- 后台 agents、teams、worktree、cron/scheduled tasks。
- hooks 事件、决策语义、信任来源和失败降级。

### R5 MCP、plugins、browser/computer-use 与企业能力

- MCP OAuth `login/logout`、pending approval、connector 和运行时重连。
- plugin zip/URL/details/eval/init/prune/tag。
- Chrome/computer-use/remote-control/gateway/ultrareview 中哪些是通用 kernel、哪些是 Anthropic 云产品专属。
- 只对本项目真正需要的差异形成开发任务。

## 5. 差分测试规则

### 5.1 隔离

- 每次运行使用临时 `HOME`、临时 CWD 和独立 config。
- 默认使用 `--bare`/`--safe-mode`、空 tools 或只读工具。
- 默认不发真实模型请求，不启动外部 MCP，不加载用户现有 hooks/plugins/settings。
- 禁止在输出和文档中记录 OAuth、API key、bearer、cookie 或用户会话内容。

### 5.2 同一输入、双边快照

每个 case 至少记录：

- 命令行和环境白名单。
- stdout/stderr 结构、exit code、超时和信号。
- 新建/修改文件清单及内容哈希。
- JSONL/event/schema 的结构化差异，不用纯文本 diff 比 JSON。
- 差异分类 A-E、证据等级和是否影响本项目。

### 5.3 证据等级

| 级别 | 标准 |
|---|---|
| A | 官方二进制黑盒行为 + 字符串/局部 minified JS + cc-haha 源码三方一致 |
| B | 官方黑盒行为与 cc-haha 源码一致，但未恢复官方静态实现 |
| C | 只有官方字符串、help 或 cc-haha 单方实现 |
| 未知 | 需要账号、服务端开关或高风险副作用，当前不测 |

## 6. 对本项目的优先级

首轮差异中，值得优先研究的不是 UI 命令数量，而是：

1. **动态系统提示词分离与 prompt cache。** 直接影响使用英文内核提示词后的成本和缓存稳定性。
2. **`auto/manual` 权限模式。** 可能代表官方权限产品语义的新一轮变化，必须与本项目安全不变量分开审查。
3. **后台 Agent 管理。** 官方 `agents` 已从“列出配置”变成完整后台会话入口，与本项目后台任务/子代理直接相关。
4. **MCP OAuth 与 pending trust。** 官方 2.1.207 的可见契约已比当前 cc-haha 帮助面更严格。
5. **safe mode 和 plugin eval。** 对插件故障恢复、quarantine 和上线前验证有直接参考价值。

只有上述契约差异形成确定证据后，才另立代码实现任务；本逆向项目本身不直接把官方二进制中的专有实现复制进仓库。

## 7. 来源与合规边界

- 官方 2.1.207 作为**行为与契约 oracle**，不把解出的大段 minified 专有代码写入本项目。
- WorkBuddy 解包产物只用于对照，不复制它的品牌、政策、服务器或产品特有实现。
- `cc-haha-ref/LICENSE` 已明示授权使用/修改，但“仓库内有许可文本”与“发布者对所有上游代码确实拥有转授权”是两个问题。工程上持续记录复制来源和修改边界；对商业分发的法律结论需独立律师核验。

## 8. 完成标准

该项目不以“读完 61 万行”为完成，而以下列产物为准：

- 每个关键子系统有官方 2.1.207 / cc-haha / 本项目三列矩阵。
- 每个差异都标注 A-E 类别、证据级别、用户可观察影响和本项目决策。
- kernel P0 差异有可重复的离线黑盒 case，而不是只有字符串猜测。
- 不把 Anthropic/WorkBuddy 专有实现、用户凭据或真实会话内容写入仓库。
- 只把已证明相关、且符合本项目安全/产品边界的差异转成开发任务。
