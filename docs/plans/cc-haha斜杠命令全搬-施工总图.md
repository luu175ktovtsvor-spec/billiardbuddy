# cc-haha 斜杠命令全搬 · 施工总图

> 📌 状态:✅现行施工蓝图 · 建于 2026-07-09(对应 task #24)
> 来源:对 `~/Desktop/cc-haha-ref` 命令注册表(`src/commands.ts`、`src/types/command.ts`、`src/commands/*`、`src/skills/bundled/*`)+ 本仓库 `ts/src/commands`、`ts/src/skills`、`ts/src/packs/billiards` 的逐条比对。
> 铁律:**机制照抄 cc,但用户可见文字(description / 面板标签 / 帮助 / 报错)一律按 WorkBuddy 中文口径重写、去 Claude 字样;品牌名走白标(BILLIARDBUDDY.md / .billiardbuddy,常量在 `ts/src/harness/memoryNames.ts`)。**

## 一句话结论

cc 能敲 `/` 的东西 = 约 **90 条命令 + 16 个 bundled skill**。我们**装载机制已齐**(loader/工具/白标目录/frontmatter/技能清单注入/`/api/v1/agent/commands`),但**内容基本为零**——除 `fork`(内置)、`/台球`(领域包入口)外几乎全缺。绝大多数可"直接抄"或"白标适配";约 20 条是 Claude 专属(登录/计费/遥测)需按我们**免登录 + 内置 key 走网关 + 去钱味**口径换,或 N/A。

## cc 命令的三种 `type`(决定落到我们哪)

- **`prompt`(~8 条)**:展开成给模型的提示 = **技能**。跟我们架构 1:1,**直接抄**(写成 markdown skill/command,落 bundled 或 `.billiardbuddy/`)。
- **`local`(~12 条)**:本地执行出文本(clear/compact/cost/files/vim/rewind…)。我们目前**没有** local 型 → **波次 0 前置**:给 loader 加"本地动作命令"类型。
- **`local-jsx`(~55 条)**:交互式面板(设置/选择器)。桌面版里**大多变成 renderer 面板** + 一条轻量斜杠入口。

## 实现波次(按依赖排,能并行的同批)

- **波次 0 · 命令类型底座(前置,阻塞 local/local-jsx 全部)**:给命令系统加 local(本地动作)+ local-jsx(→renderer 面板)两类落法。不做则 B/C/E 类大半无处落。
- **波次 1 · 纯 prompt 技能(零依赖,可全并行,直接抄)**:commit、commit-push-pr、review、security-review、pr-comments、init(→BILLIARDBUDDY.md)、insights、agent;bundled:verify、simplify、debug、lorem-ipsum、remember、skillify、loop、batch、keybindings-help。**先出量**。
- **波次 2 · 会话/上下文 local 动作(依赖波0 + 文件式存储)**:clear、compact(复用现有压缩)、files、cost(去钱味)、summary、rename、tag、export、copy、context。
- **波次 3 · 设置面板 local-jsx(依赖 renderer + 各内核已就绪)**:permissions、sandbox、config、hooks、theme、color、model(网关白标只暴露能力档)、mcp、plugin、reload-plugins、memory(→BILLIARDBUDDY.md)、tasks、agents、skills、doctor、stats、help(接现有清单)。内核多已有,主要补面板+入口。
- **波次 4 · 依赖新机制(排最后)**:rewind/branch/resume(依赖会话 checkpoint/分叉/索引)、bridge/remote-control/peers/session(依赖 bridge 通道,部分已有)、schedule/loop 远程。轻量项 statusline/effort/fast/brief/goal/plan 可穿插。
- **波次 5 · 换口径/占位(Claude 专属)**:见下表。

## Claude 专属命令的适配口径

| cc 命令/技能 | 我们口径 |
|---|---|
| login/logout/oauth-refresh | **N/A**——免登录单用户,删。仅 BYOK 高级档才有"填自己 key"入口(配置项非账号登录)。 |
| model/advisor | 走网关白标,**只暴露能力档(快/强/写实生图/长上下文),绝不显示底层供应商与模型名**。 |
| upgrade/extra-usage/subscribe/passes/rate-limit-options | **N/A**——内置 key、无消费上限、无套餐。真限流只出中文提示,不引导付费。 |
| usage/cost/stats | 换"本机用量统计"(会话/时长/token),**不显示 $、不显示套餐**;去钱味。 |
| status/privacy-settings | 去账号/云隐私,改"本机+网关连通状态""本地数据存哪、怎么清"。 |
| stickers/thinkback/claude-api | **N/A**——品牌周边/年度营销/底层 API 手册,与白标冲突,删。 |
| feedback/issue | 改"内置反馈渠道/发给 owner",去 Claude Code、去 #claude-code-feedback。 |
| install-github-app/install-slack-app | 按我们集成或先占位;文案去 Claude 品牌。 |
| desktop/mobile/teleport/session/remote-env/remote-setup/ultrareview/ultraplan/share | 依赖 Claude 云/远程环境 → **N/A**;需类似能力用我们 bridge 通道重做。 |
| stuck/schedule(bundled) | 去掉"发 Slack / 远程 agent",改本地诊断报告 / 本地定时。 |

**明确不做(N/A)**:login/logout/oauth-refresh/upgrade/extra-usage/rate-limit-options/passes/subscribe(*)/stickers/desktop/mobile/teleport/remote-env/remote-setup/ultrareview(云)/ultraplan(云)/share(云)/thinkback/claude-api/agents-platform/ant-trace/perf-issue/mock-limits/reset-limits/bridge-kick/good-claude/backfill-sessions/output-style。

## Bundled skills(16)搬运判定

直接抄:verify、simplify、lorem-ipsum、loop。白标适配:debug、remember(提升到 BILLIARDBUDDY.md)、skillify(接 create_skill,落 .billiardbuddy/skills)、batch(接子代理+worktree)、update-config、keybindings-help、stuck(去 Slack、改本地报告)、schedule(改本地/网关定时)、claude-in-chrome(接我们浏览器自动化)。N/A/后期:claude-api(删)、dream/hunter/runSkillGenerator(stub 无源码,后期按通用实现)。

> ⚠️ **参考源的坑**:cc-haha ref 是外部构建,ant 内部命令与部分 feature 命令(proactive/torch/peers/workflows/dream/hunter…)源文件已被 `bun build` DCE 成 `@generated stub`(空 Proxy),**没有真实逻辑可抄**——只能按命令名+注册表注释+通用实现搬。

## 与"斜杠命令=技能"底座怎么衔接(不重复造)

我们底座天生就是"斜杠=技能"(commit eb342e7 已落 `skillListing.ts` + `/api/v1/agent/commands` + 系统提示注入)。搬运吃现成红利:

1. **写成 markdown 落 `.billiardbuddy/commands/` 或 bundled skill,就自动进清单注入 + `/` 面板**,无需逐条接线。
2. **`/help`、`/skills` 直接复用清单格式化函数**,不重写。
3. **落点分层**:app 内置(=cc bundled)打进包 `source:'bundled'`;用户自建/领域包 → `~/.billiardbuddy/skills`、`~/.billiardbuddy/commands`(**绝不 .claude**);⚠️ 工作区 `.billiardbuddy/skills` 加载**必须传 `hookSource:'local'`**(否则工作区 skill 的 command hook 绕过信任门)。
4. **skillify/create_skill 闭环已在**:cc skillify 对应我们 create_skill,把中文提示词写好接上即可(注意修 create_skill 写盘 bug:现指向已删 `server/skills`)。
5. **接口 = frontmatter**:搬运时把 name/description/whenToUse/allowedTools/argument-hint/arguments/model/context/agent/hooks 填对,技能生态那套(推荐/检索/排序/沉淀)自动生效。
