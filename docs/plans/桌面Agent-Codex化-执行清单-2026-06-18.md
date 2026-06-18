# 桌面 Agent · Codex 化 · 执行清单（2026-06-18 · 权威执行文档）

> **第一读者是 AI。** 这是把"桌面版做成 Codex 那种效果"落到每一步的执行清单。配套：架构见 `桌面AI-Agent-架构与开发计划-2026-06-18.md`，能力地图见 `桌面Agent-完整能力地图-路线图.md`，本地操作设计见 `桌面AI-Agent-本地操作能力-真Agent化-设计.md`。本文聚焦"怎么做、改哪些文件、产出什么、验收口径"。

## 0. 已拍板决策（2026-06-18，本轮新增）

| 决策点 | 结论 | 影响 |
|--------|------|------|
| 大模型 key 谁出 | **纯 BYOK，老板自带 key** | 盒子不内置任何平台 key；启动器注入本机持久化 `BYOK_ENCRYPT_KEY`；首启引导填 key |
| 分发平台优先级 | **先 Windows 为主，Mac 暂缓** | P0 打包转 Windows nsis；Mac 维持未签名"右键打开"/自用；$99 Apple 证书后议 |
| 出包方式 | **Mac 开发 + GitHub Actions 云端 Windows runner 自动出包** | 不买实体 Windows；PyInstaller 不能交叉编译，Windows 后端 .exe 必须在 Windows 上打 → 用云 Windows |
| 验证节奏 | **一次性全部开发完，最后统一验证**（用户明确要求） | 开发期不每步跑流程；只做廉价静态检查（node --check / tsc），端到端留到最后 |

> ⚠️ **"解压"误区已澄清**：Windows 用户拿到的是 `.exe` 安装包，双击安装（像装微信），**不是解压**。出包发生在 GitHub 云端虚拟 Windows 机，不需要任何人在实体 Windows 上操作。唯一可选的实体 Windows 用途=最后真机试装一次（一次性）。

## 1. "做成 Codex 那种效果" = 学形态、不学通用操作

- **学 Codex/Claude Code 的**：① 桌面 GUI（不给 CLI）；② 长在电脑上（读写本地文件/改 Excel 报表）；③ 工具执行层 + 大模型当脑子；④ 四层防御（权限模式 + allow/ask/deny + 沙箱 + 审批闸）；⑤ 自动更新。
- **不学的**：通用 Computer Use / 任意命令任意文件（OSWorld 通用操作成功率仅 38-72%、危险、对台球无用）。能力**收窄在台球运营**——深而专的工具箱，不是什么都能动的通用 agent。这与《终局蓝图》既有结论一致。

## 2. 分阶段执行清单

### P0 · 地基：让它装上去真能跑 + 能交付（最高优先，不做完后面全是空中楼阁）

- [ ] **P0.1 修大模型 key 卡点（BYOK 能跑）** ⭐致命
  - 改 `desktop/src/backend.js`：仿 `secretKey()` 加 `byokKey(userDataDir)`，持久化到 `userData/byok.key`，注入 env `BYOK_ENCRYPT_KEY`。否则桌面填 BYOK → `PUT /me/byok` 报 503。
  - 首启引导：桌面单机版进入后必须有显眼入口填自己的大模型 key（复用 `web/src/components/byok-config-sheet.tsx`）；没填 key 时生成报错要给"去填 key"的友好引导而非裸报错。
  - 产出：桌面装上去、填好自己的 DeepSeek/MiMo key → AI 能写东西。
- [ ] **P0.2 发布 worker 打进包（用户免装 Python）** ⭐交付硬伤
  - 现状：`publish.js` 用系统 `python3` + 用户要手动 `patchright install chromium` → 普通老板装不了。
  - 做法：`desktop/scripts/build_publisher.js` 用 PyInstaller 把 `publisher/cli.py` 打成可执行；patchright Chromium 内核首次用发布功能时由程序自动下载（带进度 UI），不让用户敲命令。
  - 产出：装完即可用发布功能，零额外安装。
- [ ] **P0.3 自动更新** ⭐用户直接问"以后怎么更新"
  - 加依赖 `electron-updater`；`package.json` build 加 `publish`（先用 `generic` 指向自有 HTTPS 静态目录，或 GitHub Releases）；`src/main.js` 接 `autoUpdater.checkForUpdatesAndNotify()` + 下载完提示重启。
  - 全量更新（差量不做依赖）。⚠️ Mac 自动更新需签名——Mac 暂缓，故自动更新先保 Windows 生效。
- [ ] **P0.4 Windows 云端出包（GitHub Actions）** ⭐核心交付链路
  - 新增 `.github/workflows/desktop-build-win.yml`：`runs-on: windows-latest` → checkout → 装 Node/Python/uv → 构建前端 standalone（`scripts/build_frontend.js`）→ PyInstaller 打后端（`scripts/build_backend.js`，Windows 上产出 .exe）→ 打 publisher → `electron-builder --win` 出 nsis → 上传 artifact / 发 Release（喂自动更新）。
  - 触发：push tag `v*` 或手动。产出：GitHub 下载页拿到 `台球运营管家-Setup-x.y.z.exe`。
  - 校准 `package.json` build.win（nsis 配置、图标、`publish` 字段）。
- [ ] **P0.5 desktop/ 提交 git** ⭐当前未追踪、有丢失风险
  - 确认 `desktop/.gitignore` 已忽略 node_modules/dist/resources/.pyinstaller-build（已确认 ✅）；提交 `desktop/src`、`publisher`、`scripts`、`package.json`、配置。
- [ ] **P0.6 打包本地语义模型 fastembed+bge-zh** 🔴新增（2026-06-18 末程，desktop 已默认 `RAG_EMBEDDER=fastembed`）
  - `build_backend.js` PyInstaller 要：① 把 `fastembed`+`onnxruntime` 打进去（onnxruntime 是 native 库，补 hidden-import/collect-all，漏了运行时崩）；② **预置 `BAAI/bge-small-zh-v1.5` 模型（~90MB）进包** + 运行时设 `HF_HUB_OFFLINE=1`，否则老板首次用要联网拉 90MB。
  - 不做的话兜底：模型首次用联网拉一次（~90MB）存本机缓存、之后离线——能用但首次有延迟。
  - 云端 web 默认 deterministic（不设 RAG_EMBEDDER），不下模型、不受影响；fastembed 已进 pyproject。

### P1 · 长在电脑上更深（桌面唯一能给、云端给不了的质变）

- [ ] **P1.1 报表直改 edit_report 旗舰**：`local_tools.py` 已有 `edit_excel`/`write_file`（沙箱+审批）。补"一句话改报表"的完整体验：让 Agent 能定位用户当场选的 .xlsx、给改动 diff、人确认才落盘、改前自动备份（备份已有）。前端给"选文件 → 说要改什么 → 看 diff → 确认"的流。
- [ ] **P1.2 读 POS 导出 Excel 做真诊断**：加只读工具/流程，读老板从收银系统导出的 Excel（营业额/台时/上钟），喂经营诊断。POS 只读不控边界不破。
- [ ] **P1.3 本地操作决策 eval**：仿 `server/evals/`，建本地工具选择 eval（选对工具/越权拒绝/审批触发），量化验证"模型进盒子后逻辑对"。

### P2 · 融合老功能 + 主动层

- [ ] **P2.1 prompt_key 透传**（零迁移、最高性价比）：给 `tools.py` 的 `write_operation_content` 加可选 `prompt_key`，透传到 `generate_workbench` 的 `if prompt_key` 分支 → Agent 一句话复用全部 63 个精修模板，覆盖度 30%→接近 105 卡。
- [ ] **P2.2 卡片改造成"对话内快捷指令"**：105 张岗位卡片从"独立货架"升级为对话里的快捷入口（点卡→弹 mini 表单填槽位→喂 Agent），参照扣子 Coze 快捷指令范式。卡片不退场、降级为"给 Agent 喂结构化意图的探针"。
- [ ] **P2.3 主动出击**：今日推荐演进为本地定时/事件触发产"草稿/建议"（不自动发布），桌面通知老板过目。

### P3 · 收尾加固

- [ ] **P3.1 CC Switch 式多供应商快切**：BYOK 从单条扩成多条 + active 指针；预设卡片网格（DeepSeek/MiMo/火山/硅基…）；写入用原子写+自动备份+永远留一个可用配置。
- [ ] **P3.2 审批参数绑定**：`/agent/execute` 校验确认时 args 与提案 args 一致（防前端篡改），对本地写文件/Excel 尤其重要。
- [ ] **P3.3 知识加密升级**（按需）：从"key 烘进二进制"升级为"激活时云端拉加密包 + 一机一密"，`load_pack` 接口不变。
- [ ] **P3.4 Mac 正式签名**（待用户买 $99 Apple 账号后）：hardenedRuntime + entitlements + notarytool 公证 + 出 Intel/universal 包。

## 3. 最后统一验证清单（开发全部完成后一次性做）

1. Mac 本地：`desktop/` dev 模式起 → 填 BYOK key → Agent 写文案/改报表/发布全链路过一遍。
2. Windows：GitHub Actions 出 nsis → 真机试装 → 双击安装 → 同样全链路。
3. 自动更新：发一个 +0.0.1 版本，验证旧版能检测到并更新。
4. 回归：`bash scripts/test.sh`（后端 pytest + 前端 vitest + tsc）全绿；北极星 eval 不回退。

## 4. 文档更新清单

- [x] 本执行清单（新建）。
- [ ] `CLAUDE.md`：校正过时数字（卡片 96→105、子路由 25→28）；桌面版决策（纯 BYOK / Windows 优先 / CI 出包）补进项目状态区。
- [ ] 架构计划 `桌面AI-Agent-架构与开发计划-2026-06-18.md`：进度区追加 P0 完成情况。
- [ ] 完成后更新项目记忆 `desktop-agent-pivot-2026-06-18.md`。
