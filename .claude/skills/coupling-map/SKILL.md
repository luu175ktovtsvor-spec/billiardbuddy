---
name: coupling-map
description: 重生/刷新本项目的耦合地图(docs/耦合地图与改动检查清单.md)。当用户说"更新耦合地图/重做耦合地图/改了接口/coupling map过期了/理清前后端联动",或改动了 web/src/lib/api.ts 与 server/api/v1 路由这类承重接口、需要把"谁连谁、改这坏那"重新梳清时使用。
---

# coupling-map：半自动重生耦合地图

把"前端↔后端↔service 接线"和"改这→坏那的人工判断"重新梳进 `docs/耦合地图与改动检查清单.md`。
分两层：**机械层**(确定性脚本，治"过期")+**判断层**(只读子代理审查，给"人工判断")。

## 何时用
- 改了 `web/src/lib/api.ts` 的方法、或 `server/api/v1/` 的路由 → 至少跑机械层刷新接线表。
- 删/加了功能、子系统大改 → 跑完整流程（机械层 + 判断层）重生全图。
- `test_coupling_map_fresh.py` 红了 → 说明接线表过期，跑机械层 `--write` 即可修。

## 铁律（必须遵守）
1. **标「架构决策」的段落（§8 知识库形态、§9 prompt-cache 纪律）原样保留，一字不改**。它们是"别重做"的权威落点，不在重生范围内。
2. **判断层只读**：派去审查的子代理只读代码，绝不改文件。地图由主循环统一落笔（"映射子系统"和"改它"不混在一个上下文）。
3. **每条耦合标来源**：`[机械]`=脚本实锤，`[判断]`=代码审查推理。抽不到/拿不准的标 `[需人工确认]`，不静默丢、不假装抽全。
4. **改完必验**：跑 `cd server && uv run pytest tests/ -q` 全绿（尤其 `test_coupling_map_fresh.py`）。

## 流程

### 第 1 步 · 机械层（确定性，先跑）
```bash
python3 scripts/build_coupling_map.py          # 预览接线块
python3 scripts/build_coupling_map.py --write  # 写回地图的 AUTO-GENERATED 区
```
脚本(`scripts/build_coupling_map.py`)产出：
- **接线表**：前端 `api.ts` 方法 → HTTP 端点 → 后端路由函数 → service。
- **死方法**：前端在调、后端无此路由（调用必失败，可清理）。
- **无前端调用的路由**：agent/SSE/内部直连可能正常，仅供核对。

只要接口变了没大改架构，**到这一步就够了**——`--write` 刷新接线表，跑测试，结束。

### 第 2 步 · 判断层（架构有改动时才做）
派**只读 Explore 子代理**，按当前活子系统分片审查，各自产出带 `文件:行号` 的"承重件 / 改这→坏那 / 暗雷"。分片以实际路由(`server/api/v1/router.py` 注册的)和 services 为准，当前约为：
1. Agent 大脑：`services/agent/{loop,registry,tools,local_tools,approval,hooks,context,scenario_catalog}.py` + `api/v1/agent.py`
2. 生成管道 + 租户：`services/content_service.py`(run_generation) + `ai/prompt_engine.py` + `ai/factory.py` + `core/tenant.py`
3. 店脑 + BYOK：`services/memory_service.py` + `ai/failover.py` + store-memory 路由
4. 画布：`api/v1/canvas.py` + `services/canvas_service.py`
5. 单窗口前端：`web/src/lib/api.ts` + `hooks/auth-context.tsx` + `app/page.tsx`/`dashboard/chat` + `components/desktop/*`

子代理提示词要点（每个都强调）：**只读**；每条带 `文件:行号`；**核对现状真伪**（旧地图很多已失真，别照搬）；分「承重件/高危联动/暗雷」三段，简洁。

### 第 3 步 · 主循环落笔
汇总子代理素材，按下列结构重写 `docs/耦合地图与改动检查清单.md`（保留 §0/§6 框架）：
- §1 系统总评、§2 承重件表、§3 高危联动（按子系统分组）、§4 云端SaaS残留一行带过、§5 暗雷、§6 护栏测试、§7 接线表(留 AUTO 区给机械层)、**§8/§9 原样保留**。

### 第 4 步 · 验证
```bash
python3 scripts/build_coupling_map.py --write   # 确保接线表是最新的
cd server && uv run pytest tests/ -q            # 全绿，尤其 test_coupling_map_fresh
```

## 相关文件
- `scripts/build_coupling_map.py` — 机械层抽取脚本
- `server/tests/test_coupling_map_fresh.py` — 接线表新鲜度守栏
- `docs/耦合地图与改动检查清单.md` — 产物（人读的活地图）
- `docs/superpowers/specs/2026-06-23-coupling-map-skill-design.md` — 设计稿
