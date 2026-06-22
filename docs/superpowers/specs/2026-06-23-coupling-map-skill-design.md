# 设计：`coupling-map` skill + 重生耦合地图

> 日期：2026-06-23 · 阶段：brainstorming 产出的设计稿（待用户复核 → 进 writing-plans）
> 背景痛点：项目代码变多、接口联动变密（前端↔后端、后端内部环环相扣）后，AI 改代码逻辑易乱。现有 `docs/耦合地图与改动检查清单.md` 是 2026-06-14（桌面化转向之前）的快照，约一半内容指向已删除的云端 SaaS 形态，已沦为误导。

---

## 0. 目标与非目标

**目标**
1. 写一个**开发期** Claude Code skill `coupling-map`，能半自动重建/刷新本项目的耦合地图，且让"接线层"可被测试守住、不再悄悄过期。
2. 用这个 skill 重生一份贴合**当前桌面产品**的 `docs/耦合地图与改动检查清单.md`。

**非目标**
- 不引入重型依赖（不上 graphify 的图谱/树-sitter/Leiden 那套）——纯本地、不过度设计。
- 不动运行时知识库 `prompts.enc`，与 §8「不迁 SKILL.md」决策无关（那是运行时 BYOK 知识库；本 skill 是开发期工具，放 `.claude/skills/`）。
- 不做无关重构。

---

## 1. 调研已确认的事实（设计依据）

- **配额/计费在桌面是死代码**：`server/services/quota_service.py:104,142` 明确 `DESKTOP_LOCAL=1` 直接短路跳过平台配额（"云端 SaaS 限制不该漏进 BYOK 盒子"）。订阅/续费/生命周期路由 `router.py` 未注册。
- **当前真实活路由 9 个**（`server/api/v1/router.py`）：`auth / stores / dashboard / quota / members / logs / store-memory / agent / canvas`。无 reports、无订阅计费、无 stream。
- **旧地图大量指向已删文件**：`stream.py`、`reports.py`/`report_service.py`、`quota-badge.tsx`、`dashboard/page.tsx`、`role-workbench-config.ts` 均已不存在。
- **前端已是单窗口**：`web/src/app/` 仅 `page.tsx` + `(auth)/login` + `(auth)/register` + `dashboard/chat`；`web/src/components/` 共 17 个组件（旧地图写"24 个前端文件"已失真）。
- **仍存活的承重件**：`core/tenant.py`、`services/content_service.py`(`run_generation`)、`services/ai/prompt_engine.py`、`web/src/lib/api.ts`、`web/src/hooks/auth-context.tsx`。
- **必须原样保留的金子**：旧地图 §8（知识库形态决策·别再提向量化/GraphRAG/迁SKILL.md）、§9（prompt-cache 前缀纪律），均为带守栏测试的"别重做"架构决策。

---

## 2. 架构：混合型 skill（机械层 + 判断层）

```
.claude/skills/coupling-map/
  SKILL.md                     # 触发条件 + 编排流程（判断层指挥）
scripts/build_coupling_map.py  # 机械层：确定性抽取前端↔后端↔service 接线
server/tests/test_coupling_map_fresh.py  # 守栏：机械接线表 vs 代码，漂移即红
docs/耦合地图与改动检查清单.md  # 产物：人读的活地图（机械表 + 判断段 + 架构决策）
```

两层各司其职、接口清晰、可独立理解与测试：

### 2.1 机械层（确定性脚本，不靠 AI）

`scripts/build_coupling_map.py`：

- **输入**：`web/src/lib/api.ts`、`server/api/v1/router.py` 及各路由文件。
- **抽取**：
  1. `api.ts` 每个方法 → 它请求的 `/api/v1/...` 端点（正则扫 `this.request("METHOD", "/path")` 与裸 `fetch(...)`）。
  2. `router.py` 的 `include_router(prefix=...)` + 各路由文件的 `@router.<verb>("/path")` → 端点全路径 → 路由函数 → 该函数 import/调用的 service 模块。
- **输出**：
  1. 一张确定性对照表 `前端方法 → HTTP端点 → 后端路由函数 → service`（Markdown 片段，带 `<!-- AUTO-GENERATED -->` 标记，供地图嵌入）。
  2. 两份"裂缝清单"：**前端有方法但后端无匹配路由**（死方法，如刚清掉的 report 系列）；**后端有路由但前端无调用方**。
- **确定性**：同一份代码跑出字节一致的表（排序稳定），便于守栏比对。

### 2.2 判断层（`SKILL.md` 指挥 AI）

- 派**只读 Explore 子代理**，按当前活子系统分片，各自产出"改这→坏那 / 暗雷 / 隐式契约"。分片（初定，实现时以实际路由/services 为准）：
  1. Agent 大脑（`services/agent/{loop,registry,tools,local_tools,approval,hooks,context}`）
  2. 生成管道（`content_service.run_generation` + `prompt_engine` + knowledge YAML 注入）
  3. 租户 & 数据安全（`core/tenant.py` + SQLite 方言兜底）
  4. 纯 BYOK（`services/ai/factory.get_image_config_for_store` + `failover`）
  5. 画布（`api/v1/canvas.py` + `canvas_service`）
  6. 店脑记忆（`memory_service` + `store-memory` 路由 + 末尾注入约束）
  7. 单窗口前端（`api.ts` + `auth-context` + `app/page.tsx`/`dashboard/chat` + `components/desktop/*`）
- **保留规则（铁律）**：标注「架构决策」的段落（§8、§9，及未来新增同类）**禁止重写，原样保留**。SKILL.md 显式写明。
- **透明度标注**：每条耦合标 `[机械]`（脚本来的实锤）/`[判断]`（子代理推理），借 graphify 的 EXTRACTED/INFERRED 思路。
- **只读不改**：探索子代理只读；写地图由主循环统一落笔（遵循"映射子系统"与"修改它"不混在一个上下文）。

---

## 3. 重生地图的结构（本轮产物）

保留旧地图的好结构，按当前桌面产品重写：

| 段落 | 处置 |
|------|------|
| §0 怎么用 | 保留，更新测试命令（`uv run pytest` + 新守栏 + 接线脚本如何重跑） |
| §1 系统总评 | 改写为桌面形态（Agent ReAct + 纯 BYOK + 单窗口 + 本地 SQLite + 四层防御） |
| §2 承重件 | 删死行（报表引擎 / role-workbench 四向契约 / stream.py 管道）；留改活的（tenant / api.ts / run_generation / prompt_engine / auth-context）；新增 Agent 时代承重件（`loop.py`+`registry.py` 工具系统 / `approval.py` 审批签名 / `local_tools` 沙箱） |
| §3 高危联动 | 留活的（店脑末尾注入 / run_generation 注入店脑 / StreamGuard 泄露词 / X-Store-Id 三处手写 / api.ts SSE 双套 401）；删死的（quota-badge useEffect / dashboard 三处 map / role-workbench prompt_key） |
| §4 计费裂缝 + §7.1/7.2 日报 | **塌缩成一行**："云端 SaaS 残留，桌面 `DESKTOP_LOCAL` 短路跳过配额 / 日报功能已删，不构成桌面耦合" |
| §5 暗雷 | 留相关（sub_type 语义随 gen_type 变 / `_format_price_field` 价格打码单点 / 店脑 consolidate 抢写 / 时区双基准——以 dashboard 仍用为准）；删订阅相关（FK 级联 / status 死字段 / 后台学习未计费等纯 SaaS） |
| §6 护栏测试 | 更新为现存测试 + 新增 `test_coupling_map_fresh.py` |
| §7 历史处置 | 旧 7.x 计费/日报段落归并为"历史（已不适用桌面）"一句，或移除 |
| §8 / §9 架构决策 | **原样保留，一字不改** 🏆 |
| 新增 · 接线表 | 机械层产出的 `前端↔后端↔service` 对照表（`<!-- AUTO-GENERATED -->`） |

---

## 4. 数据流

```
开发者改了承重接口
  → 跑 /coupling-map（或 python scripts/build_coupling_map.py）
    → 机械层抽接线表 + 裂缝清单（确定性）
    → 判断层派只读子代理补"改这→坏那/暗雷"，保留架构决策段
    → 写回 docs/耦合地图与改动检查清单.md
  → 跑 pytest：test_coupling_map_fresh.py 比对机械表 vs 现状
    → 漂移 → 红（提示重跑 skill）
    → 一致 → 绿
```

---

## 5. 错误处理与边界

- **机械层抽不到**（api.ts 写法超出正则覆盖、动态拼端点）：脚本把无法静态判定的标 `[需人工确认]`，不静默丢，不假装抽全（遵循"抓不到就直说"）。
- **守栏测试**只比对机械可判定部分；判断层的散文不纳入测试（人写的判断不该被机械卡）。
- **架构决策段保护**：SKILL.md + 实现时以"段落标题含『架构决策』"为锚，重写流程跳过这些段。
- **守栏宽严**：`test_coupling_map_fresh.py` 首版只断言"地图接线表里列的端点，后端真实存在 / api.ts 方法的端点后端有路由"——避免过严导致每次微调都红。具体断言粒度在 writing-plans 阶段定。

---

## 6. 测试策略

- 新增 `server/tests/test_coupling_map_fresh.py`：机械接线表与真实路由/方法一致；死方法清单为空（或在白名单内）。
- 回归：`cd server && uv run pytest tests/ -q` 全绿；现有 `test_coupling_guards.py` / `test_prompt_cache_discipline.py` 不破。
- 前端不受影响（skill 是开发期工具，不进打包产物）。

---

## 7. 待 writing-plans 细化的点

- 机械层正则的具体覆盖范围与 `[需人工确认]` 判定规则。
- `test_coupling_map_fresh.py` 的断言粒度（端点存在性 vs 完整接线等价）。
- 子代理分片的最终边界（以实现时实际 services/路由为准）。
- 接线表在地图中的位置与 `<!-- AUTO-GENERATED -->` 区块的更新方式（整块替换）。
