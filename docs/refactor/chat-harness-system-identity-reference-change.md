# 聊天 Harness 系统身份与上下文边界：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 的聊天 Harness 重建。目标不是对旧提示词做品牌替换，而是确定 BilliardBuddy 执行模型真正需要知道的稳定行为、动态上下文和扩展指令，并把宿主实现、供应商协议和工作台内部状态留在模型之外。

## 直接结论

- 系统提示词只描述模型必须遵守的执行与沟通契约；权限快照、运行 ID、凭据、IPC、持久化、provider 路由和媒体 Job 内部状态由 Harness 强制执行，不依赖提示词保密或自律。
- 静态基础提示词与动态上下文分开。基础提示词保持可缓存；工作目录、日期、项目指令、长期记忆、compact 摘要和 Hook 附加上下文按来源分别标记。
- 可用能力以当前 Turn 实际提供的 Tool schema、Skill 展开结果和 MCP Tool 为准，不在基础提示词里维护一份容易漂移的工具清单。
- 只有 `AGENTS.md` 与 BilliardBuddy 指令入口属于项目指令。普通文件、网页、Tool/MCP 返回值和附件内容是待处理数据，不能自行升级为系统指令。
- 聊天没有媒体工作台 Tool 时，不把 `MediaProject`、画布、时间线、Job、Version 等内部实现名灌给模型；产品边界由工具发现和 Host 路由共同保证。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| 本仓库 Claude Code 衍生源码：`ts/src/constants/prompts.ts`、`ts/src/utils/systemPrompt.ts`、`ts/src/constants/system.ts`，当前仓库基线 `c7ac1b2cfd702832328eb3eb25f06731bf7da9f0` | 直接源码。成熟实现把身份、做事原则、工具使用、语气、输出效率与动态环境拆成独立段，并在请求前统一组装；但其品牌、CLI、实验开关和供应商专属内容不属于 BilliardBuddy。 | 不能删掉成熟 Harness 的行为约束，也不能把历史品牌、CLI 功能和所有内部机制继续发送给模型。 | `ts/src/server/agent-worker/productAgentLoop.ts` 当前只有一段固定字符串，再把所有上下文拼成无来源语义的 XML。 | BilliardBuddy 的系统提示词构造器；当前 Turn 的冻结上下文快照。 | 重写为 BilliardBuddy 静态基础段、来源明确的动态上下文段和实际工具 schema；不调用旧 CLI 的默认 prompt 构造器。 | 动态上下文缺失时仅省略对应段；格式或大小不合法时在采样前失败，不退回旧提示词。 | 快照测试覆盖身份、分段、缺省、顺序、大小和禁止品牌词；真实代理请求捕获最终 system 字段。 |
| OpenAI Codex commit `61a44880a85d2fd0d8770908dea5733495e571c8`：`codex-rs/protocol/src/prompts/base_instructions/default.md`、`codex-rs/core/gpt_5_codex_prompt.md` | 官方源码。基础指令描述执行、编辑、验证和用户沟通；项目指令、权限和 Turn 上下文由 Core 另行组装，不把 App Server、数据库或供应商请求细节塞进模型身份。 | 模型需要足够的做事规则，但不应知道 Host 才能执行和校验的全部内部结构。 | `PRODUCT_SYSTEM_PROMPT` 混合身份、Host 权限、隐藏标识、模型路由和媒体内部对象。 | 静态模型行为契约；Host 的权限与持久状态仍为权威。 | 仅保留对模型行为有直接影响的原则，把权限、路由和持久化从提示词移回代码边界。 | Host 拒绝或工具失败以结构化结果回到同一 Turn；模型不可用文字覆盖真实结果。 | 权限拒绝后不重复、工具失败继续/终止、完成前验证和用户沟通测试。 |
| Pi commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`：`packages/coding-agent/src/core/system-prompt.ts`、`packages/agent/src/agent-loop.ts`；MIT | 官方源码。Prompt 根据实际工具和项目上下文构造；Agent 自有消息只在 LLM 边界转换成 provider 消息，循环本身不要求模型知道 provider。 | 提示词和 Harness 不能与 Anthropic 消息类型、固定工具列表或无关产品模块绑定。 | `productAgentLoop.ts` 与 session repository 仍直接使用 Anthropic SDK block 类型。 | BilliardBuddy Turn/Item/ToolCall DTO；provider adapter 只存在于模型调用边界。 | 先建立产品自有 Prompt/消息 DTO，再在模型适配器转换；不让供应商类型进入持久化与 IPC。 | 不支持的 provider 内容在适配器处显式失败；原始产品消息仍可恢复和换 provider 重试。 | DTO schema、往返转换、未知 block、tool result 配对、resume 与 provider 切换测试。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059/raw/webview/assets/app-initial-BHB6SClA.js`、`reverse-readable/`、`host-bridge/build/` | 直接分发产物。语音对话层提示词明确把对话表面和执行后端分开；Host bridge 负责窗口、权限与执行调用。该提示词属于对话表面，不是 Core Harness 基础提示词。 | 不能把前端语音代理、聊天执行模型和 Electron Host 的职责混成一个“大一统 prompt”。 | BilliardBuddy 当前只有执行模型，但提示词写入了 Host 与其他工作台实现。 | Product Server/Harness 是执行权威；renderer 只消费 Item/Event。 | 只借鉴职责分层，不复制 Codex 品牌或语音 backend 话术；BilliardBuddy 执行模型直接面向用户完成 Turn。 | renderer 断线可从事件恢复；模型不承担前端状态同步。 | 请求捕获、事件投影、断线恢复和 renderer 真实旅程。 |

## 本单元完成边界

本单元完成必须同时满足：生产请求最终 system 内容只包含 BilliardBuddy 身份和必要行为；动态来源可辨认且有大小边界；普通内容不能冒充项目指令；Anthropic 类型不再进入 BilliardBuddy 的持久化和 IPC；旧 CLI 提示词构造器不在 Product Harness 可达图中。只改字符串或只通过源码搜索不算完成。
