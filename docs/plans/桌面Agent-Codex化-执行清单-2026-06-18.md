# 桌面 Agent · Codex 化 · 执行清单（2026-06-18 · P0-P3 历史交付账本）

> **📌 note（当前主线）**：本清单是 P0-P3 这一程的**历史交付账本**（记录当时做了什么、改了哪些文件、验收口径）。**当前活跃的 go-forward 主线工作文档已转到 `docs/完整优化清单.md`（37 项产品化优化清单）** —— 想看"接下来做什么"去那份；本文留作已交付内容的回溯依据。

> **第一读者是 AI。** 这是把"桌面版做成 Codex 那种效果"落到每一步的执行清单。配套：架构见 `桌面AI-Agent-架构与开发计划-2026-06-18.md`，能力地图见 `桌面Agent-完整能力地图-路线图.md`，本地操作设计见 `桌面AI-Agent-本地操作能力-真Agent化-设计.md`。本文聚焦"怎么做、改哪些文件、产出什么、验收口径"。

> **📍 进度速览（2026-06-18 末，代码已合入 main —— 本仓库 `main` = 桌面产品全部代码）**：**P0 / P1 / P2 / P3 + Harness 加固 + 这一程新增功能全部已落地**（详见下方各项打勾 + 一句话现状）。**仅剩**：① 打包出安装包（Windows nsis / Mac dmg）；② 真机端到端验证（填 BYOK→写文案/改报表/发布全链路过一遍）。其余开发已完成。后续产品化优化见 `docs/完整优化清单.md`。

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

- [x] **P0.1 修大模型 key 卡点（BYOK 能跑）** ⭐致命 ✅
  - **已做**：`desktop/src/backend.js` 加 `byokKey()` 持久化 `userData/byok.key` 并注入 env；首启 BYOK 引导（没填 key 首页显眼提示 + 一键设置）；没填 key 生成报错给友好引导。装上填好自己 key → AI 能写东西。（commit `d5858ac`/`87fd5dc`）
- [x] **P0.2 发布 worker 打进包（用户免装 Python）** ⭐交付硬伤 ✅
  - **已做**：`build_publisher` 接线 PyInstaller 把 `publisher/cli.py` 打可执行 + CI gate；patchright Chromium 首用自动下载。装完即可用发布功能。（commit `5eec40c`）
- [x] **P0.3 自动更新** ⭐用户直接问"以后怎么更新" ✅
  - **已做**：`desktop/src/updater.js`（electron-updater）+ `package.json` publish 字段。全量更新；Mac 自动更新需签名故先保 Windows 生效。（commit `d5858ac`）
- [x] **P0.4 Windows 云端出包（GitHub Actions）** ⭐核心交付链路 ✅（脚本/工作流已就绪，未实跑出包）
  - **已做**：`.github/workflows/desktop-build-win.yml`（windows runner → 前端 standalone → PyInstaller 打后端 .exe → publisher → electron-builder 出 nsis）；`package.json` build.win 已校准。⚠️ **工作流写好但尚未真跑出安装包**——属"仅剩"事项。（commit `5eec40c`/`d5858ac`）
- [x] **P0.5 desktop/ 提交 git** ✅
  - **已做**：`desktop/.gitignore` 忽略 node_modules/dist/resources/.pyinstaller-build；`desktop/src`、`publisher`、`scripts`、`package.json` 已入分支。（commit `d5858ac`）
- [x] **P0.6 打包本地语义模型 fastembed+bge-zh** 🔴 ✅（代码层就绪；进包预置留打包时做）
  - **已做**：`backend.js` 默认 `RAG_EMBEDDER=fastembed`；`server/services/rag/embedder.py` 用 `BAAI/bge-small-zh-v1.5`（~90MB，本地 fastembed/onnxruntime，非 pgvector），fastembed 已进 pyproject。（commit `1b988b6`）
  - ⚠️ 留打包阶段做：PyInstaller 把 fastembed+onnxruntime 打进 + 预置模型进包 + `HF_HUB_OFFLINE=1`（否则首次联网拉 90MB，能用但有延迟）——属"打包出安装包"环节。

### P1 · 长在电脑上更深（桌面唯一能给、云端给不了的质变）

- [x] **P1.1 报表直改 edit_report 旗舰** ✅：`local_tools.py` `edit_excel`/`write_file`/`edit_file`（沙箱 `_allowed_paths`+审批+自动备份）；**改文件审批加 diff 预览**（`preview_edit_file`/`preview_edit_excel`/`preview_write_file`，确认前看清会改成什么）；前端给"选文件 → 说要改什么 → 看 diff → 确认"的流 + 权限分级（谨慎/自动改文件/全自动+全盘+选文件夹，仿 Claude Code permission 模式）+ 工具实时步骤标签补全（不露裸英文名）。（commit `eee86b5`/`4647f08`/`791313e`/`0beca04`/`e01c0bf`）
- [x] **P1.2 读 POS 导出 Excel 做真诊断** ✅：`local_tools.diagnose_from_pos` 读老板从收银系统导出的营业额 Excel → 基于真实数字诊断；选报表→"照这份报表诊断"一键钮 + 没报路径兜底用选定报表。POS 只读边界不破。（commit `a3b7c79`/`8a5b3e8`）
- [x] **P1.3 本地操作决策 eval** ✅：Agent 决策 eval 扩"本地操作"覆盖（选对工具/越权拒绝/审批触发），量化模型进盒子改文件的决策。（commit `0f924a7`）

### P2 · 融合老功能 + 主动层

- [x] **P2.1 prompt_key 透传** ✅：`tools.py` `write_operation_content` 加可选 `prompt_key` 透传 `generate_workbench` → Agent 一句话复用 63 个精修模板。（commit `0fdb1a2`）
- [x] **P2.2 卡片改造成"对话内快捷指令"** ✅：卡片融合·清单法（Agent 查场景目录清单）+ 对话首屏常用场景快捷入口 + mini 表单（点卡→填槽位→喂 Agent）。（commit `0fdb1a2`/`aa671c8`）
- [x] **P2.3 主动出击** ✅：管家据今日推荐预生成文字草稿给老板过目（不自动发布）；对话开屏"今天建议你…"点一条直接做（规则零成本）。（commit `8ab4a70`/`261d8e0`）

### P3 · 收尾加固

- [x] **P3.1 CC Switch 式多供应商快切** ✅：BYOK 扩成多套 + active 指针；预设卡片网格；原子写+自动备份+永留一个可用配置。（commit `3f1156b`）
- [x] **P3.2 审批参数绑定** ✅：`/agent/execute` 校验确认时 args 与提案 args 一致（签名防"改了参数再确认"）。（commit `0232da3`）
- [ ] **P3.3 知识加密升级**（按需，未做）：从"key 烘进二进制"升级为"激活时云端拉加密包 + 一机一密"，`load_pack` 接口不变。
- [ ] **P3.4 Mac 正式签名**（待用户买 $99 Apple 账号后，未做）：hardenedRuntime + entitlements + notarytool 公证 + 出 Intel/universal 包。

### Harness 加固（本程，eval 驱动，让"模型进盒子"稳）— ✅ 5 件全做

- [x] **铁律代码闸第一块** ✅：绝对化广告词确定性兜底（不靠模型自觉）。（commit `e9e9dcb`）
- [x] **审批回灌** ✅：执行结果喂回循环，管家"知道"自己做了啥、能自然接话（修断流）。（commit `a6924f4`）
- [x] **可安全迭代地基** ✅：铁律违反率可观测（量化模型 slip 率）。（commit `e494a4f`）
- [x] **店脑按需召回** ✅：修"全量注入"→按需召回（治 context rot + 省 BYOK token）。（commit `4c0c2f7`）
- [x] **工具使用可观测** ✅：看模型选了哪些工具/失败率/轮数（喂迭代）。（commit `26f3032`）

### 本程其余新增功能 — ✅ 已落地

- [x] **真 RAG 核心** ✅：`local_tools.recall_my_content` 语义召回老板本机攒下的历史内容（`services/rag/`）。（commit `af5aeee`）
- [x] **本地语义模型 bge-zh** ✅：`BAAI/bge-small-zh-v1.5` ~90MB / fastembed / `RAG_EMBEDDER=fastembed`，"按意思找料"根治换说法就漏。（commit `1b988b6`，详见 P0.6）
- [x] **知识找料补漏** ✅：知识选取加"内容补漏"（关键词漏配按内容强相关补）+ 助教短视频触发词修复。（commit `571aec2`/`2dcb445`）
- [x] **Canvas 画布·指着某处定向改** ✅：`canvas_service` + `POST /canvas/edit`（圈选只改那段、不动别处）；`run_generation` 加 `thinking` 参数。（commit `e30a95c`）
- [x] **报表可视化点格改** ✅：`canvas.py` `POST /canvas/sheet` 读表 + `POST /canvas/excel-edit` 改（选报表"看表格"全屏铺成表格→点格内联改→保存落盘；桌面专属+自动备份）。（commit `190e9bb`）
- [x] **一键发布闭环** ✅：平台内容写完→"去发布"带文案跳发布页预填。（commit `2d72e19`）
- [x] **BYOK 成本看板** ✅：`GET /quota/cost` + 前端 `/dashboard/usage` 页（看自己 key 本月 token≈多少钱）。（commit `fc86e16`）
- [x] **批量内容 write_batch** ✅：`tools.py`「给我一周朋友圈不重样」一次出一批。（commit `fe4a3f9`）
- [x] **长对话不崩** ✅：history 封顶最近 12 条 + 每条截 2000 字符（防撑爆上下文）。（commit `32cf0a1`）
- [x] **生图也 BYOK** ✅：store 加 `byok_image_*` 字段 + migration 022 + `factory.get_image_config_for_store(store)` + 前端配置面板"生图模型"区（纯 BYOK：`DESKTOP_LOCAL=1` 未配即空 key、绝不回退平台 key，空 key → 友好 503）。（commit `6ab3912`）
- [x] **max_turns 未收敛强制收尾** ✅：不再返回空答复。（commit `6624419`）
- [x] **app 图标** ✅：`desktop/build/icon.png`（机器人+8 号球+球杆正式 logo）。（commit `54e25ee`/`7a001a8`）
- [x] **测试存档** ✅：行业真实运营资料 六岗位 60 场景（`evals/scenes/ppt_staff.yaml`）+ MiMo v2.5 实测。（commit `bbf035f`）

## 3. 最后统一验证清单（开发全部完成后一次性做）—— ⬅ **当前就卡在这一步（开发已完成）**

1. Mac 本地：`desktop/` dev 模式起 → 填 BYOK key → Agent 写文案/改报表/发布全链路过一遍。
2. Windows：GitHub Actions 出 nsis → 真机试装 → 双击安装 → 同样全链路。
3. 自动更新：发一个 +0.0.1 版本，验证旧版能检测到并更新。
4. 回归：`bash scripts/test.sh`（后端 pytest + 前端 vitest + tsc）全绿；北极星 eval 不回退。

## 4. 文档更新清单

- [x] 本执行清单（新建 + 2026-06-18 末程：P0/P1/P2/P3/Harness/本程新增全部打勾标现状）。
- [x] `CLAUDE.md`：桌面版决策（纯 BYOK / Windows 优先 / CI 出包）+「桌面 Agent 新增」整节 + 生图 BYOK / CC Switch 已补进项目状态区与「核心架构原则」第 11 条。（注：本程代码当时在 `feat/desktop-agent` 分支推进，现已合入本仓库 `main`，`main` = 桌面产品全部代码）
- [x] `docs/AI-Agent-Dev全真实改造-进度与待办.md`：已追加桌面这一程进度。
- [x] `桌面Agent-完整能力地图-路线图.md`：已勾掉本程落地能力。
- [ ] 架构计划 `桌面AI-Agent-架构与开发计划-2026-06-18.md`：进度区追加 P0 完成情况（本次未动，待补）。
- [ ] 完成后更新项目记忆 `desktop-agent-pivot-2026-06-18.md`。
