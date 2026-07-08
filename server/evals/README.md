# 北极星对齐测试体系（eval-driven 迭代引擎）

> 一句话：用固定的"模拟门店 + 场景集 + 北极星谓词"，大规模、可重复地量化"AI 产出有没有脱离北极星"。
> 这是 **DeepSeek 不会自我进化** 前提下，让产品"越来越懂台球"唯一现实的工程闭环：
> **产出 → 自动判定贴不贴北极星 → 暴露偏差 → 改 prompt/知识/记忆/换模型 → 再测验证**。

## 为什么需要它

DeepSeek API 无状态、推理时权重冻结——它不会因为我们用得多就"学会"台球。
所谓"越来越懂"全靠应用层：改 prompt/知识库、店脑记忆、**eval 驱动的人工迭代**。
这套 eval 就是那个"驱动"：没有它，改了 prompt 不知道变好还是变坏；有了它，每次改动都有量化反馈。

## 组成

| 文件 | 作用 |
|------|------|
| `northstar_predicates.yaml` | 31 条北极星硬规则谓词（标尺）：定价/合规/客户分类/服务/闭环/真实性/岗位 |
| `sim_stores.yaml` | 3 个模拟门店（社区/商业/竞技）+ 店脑记忆 + 员工记忆（前期无真实用户时的固定夹具） |
| `scenes/*.yaml` | 80 个真实台球场景，7 类：诊断/活动/内容/约客/玩法/日报/客户定价 |
| `run_northstar_eval.py` | runner：构造门店→复刻真实 prompt 拼装→真跑 DeepSeek→LLM-as-judge→三级量化 |

## 退场边界

旧 Python eval 只保留“内容质量/北极星/业务场景”这类暂时还没有 TS 等价的评测。coding agent 的 `run_command` 执行、审批分级、危险命令、Bash 只读 allowlist、文件执行工具链、provider/BYOK 连通与旧真文件操作场景已迁到 TS 内核测试/TS smoke:

```bash
cd ../ts && bun test src/tools/runCommandTool.test.ts src/permissions/permissionRules.test.ts src/permissions/resolve.test.ts --timeout 60000
cd ../ts && bun test src/harness/loop.test.ts src/tools/fileTools.test.ts --timeout 60000
cd ../ts && bun test src/model/providerConfig.test.ts src/server/services/providerService.test.ts --timeout 60000
cd ../ts && bun run typecheck
cd ../ts && bun run smoke:model        # 需要真模型 key,按需手工跑
cd ../ts && bun run smoke:agent-tools   # 需要真模型 key,按需手工跑
```

因此旧的 `cmd_live_test.py`、`file_exec_live_test.py`、`agent_tools_e2e.py`、`harness_eval.py`、`agent_full_scenario_test.py`、`_byok_api_test.py`、`_byok_e2e.py` 已删除；后续同类“命令安全/工具权限/文件执行/轨迹对抗/模型连通/provider 路由”回归继续往 TS 测试和 smoke 集中收敛。

**无数据库依赖**：构造 in-memory `Store` + 模拟记忆，复用项目纯函数复刻"发给 DeepSeek 的真实 prompt"，
绕过配额/落库/品牌声音（这些不影响"内容质量 vs 北极星"的测量）。复刻 5 种生成路径
（workbench_free / workbench_card / diagnosis / activity / outreach）。

## 怎么跑（在 `server/` 目录下）

```bash
uv run python evals/run_northstar_eval.py --dry-run          # 零成本：只加载素材+拼prompt，不调API
uv run python evals/run_northstar_eval.py --self-test        # 真跑1个内联场景，验证链路
uv run python evals/run_northstar_eval.py --limit 5          # 抽样5个
uv run python evals/run_northstar_eval.py --categories diagnosis,activity   # 指定类别
uv run python evals/run_northstar_eval.py --concurrency 3 --tag v3   # 全量（默认并发3防限流）
uv run python evals/run_northstar_eval.py --no-judge         # 只关键词（省裁判的钱）
```

报告输出到 `docs/test-runs/北极星对齐-<tag>.{md,json}`。无 DeepSeek key 自动跳过。**仅文本、零生图。**

## 判定哲学（v2 校准后）

- **LLM-as-judge 主导**：DeepSeek 当"北极星审查员"看语境打 1-5 分，这是主判据（它看得懂"不赌钱"含"赌钱"是否定语境、"中八打法"是正常术语）。
- **机器关键词只兜底**：仅 `HARD_FORBIDDEN`（任何语境都是硬伤的词，如"美女助教/包教包会/全城最低价/充1送1"）命中才机器判 RED。
  其余 must_hit / 场景 forbidden / 谓词 forbidden 只作"报告参考"，**不机械判罚**（语境敏感，机器扫会误伤——这是 v1 踩过的坑）。
- **三级**：judge≥4=🟢GREEN / ==3=🟡YELLOW / ≤2 或 HARD命中=🔴RED；judge 重试后仍无分=🟦NO_JUDGE（不污染）；生成失败=⚠️ERROR。
- **门槛建议**：全场景 GREEN 率（占有效判定）≥85% 才允许合并 main。

⚠️ **生成有随机性**（temperature 非 0），单次跑是快照、有抖动。关注**系统性偏离**（多次都中的），别被单次波动带偏。
要看稳定质量，对可疑场景多跑几次取分布（见 `_stability_probe.py` 思路）。

## 怎么扩展

- **加场景**：在 `scenes/<类别>.yaml` 的 `scenes:` 下按现有 schema 加（字段名见 runner 顶部注释，一字不差）。
- **加/改谓词**：编辑 `northstar_predicates.yaml`；语境无关的硬红线词也同步进 runner 的 `HARD_FORBIDDEN`。
- **改模拟门店/记忆**：编辑 `sim_stores.yaml`（含 `memories` 店脑 + `staff_memories` 员工记忆）。

## 典型用法：当回归门

1. 改了某个 knowledge/prompt 或换了大脑模型 → 跑一遍 → 对比 GREEN 率有没有掉。
2. 想验证"换 GLM-4.6 能不能降低铁律违反率" → 配好 `ORCHESTRATION_*` 或 `text_model_*` → 跑 → 对比。
3. 发现某类场景 GREEN 率低 → 看 RED/YELLOW 明细的 judge reason → 定位是产出问题还是测试设计问题 → 修 → 重测。
