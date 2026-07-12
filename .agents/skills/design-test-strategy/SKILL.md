---
name: design-test-strategy
description: Design proportionate automated and runtime verification for a repository change before or during implementation. Use when adding a feature, fixing a regression, changing a contract, choosing between unit, contract, integration, backend E2E, desktop E2E, smoke, or live tests, or when existing tests do not prove the requested behavior.
---

# 测试策略设计

先写清“什么证据能证明用户需求成立”，再选择最小但充分的测试组合。不要用大量低价值测试替代关键连接点验证。

## 选择层级

- 纯函数、领域规则、解析、归一化：单元测试。
- REST、WS、SSE、IPC、Schema、错误结构：契约测试，至少覆盖合法、非法和兼容输入。
- route -> service -> store/adapter：集成测试，使用假外部依赖。
- ReAct、权限、工具、落盘、事件流：`verify-backend-e2e` 的脚本模型检查点。
- React + Electron + sidecar 用户路径：`verify-desktop-e2e`，联合 DOM、截图、日志、API 和 JSONL 证据。
- 打包、资产、沙箱、真模型或远程服务：按风险选择离线 smoke；真网络测试必须明确环境、成本和不可重复性，不进普通 CI。

## 执行流程

1. 从验收行为列出成功、失败、空值、中断、重试、重启和旧数据中适用的状态。
2. 找到最靠近缺陷根因的低层测试，再补一个能跨过真实边界的高层证据。
3. 前后端契约变化同时测试生产者和消费者；不得只断言字段存在。
4. 修 Bug 时先写能复现旧错误的失败测试；结构重构先写特征测试锁住行为。
5. 避免脆弱断言：不绑定无关文案、时间、随机 id、内部调用次数或像素细节。
6. 把新增检查接入 `bash scripts/quality_gate.sh` 或对应 CI；手动验证必须报告观察结果。

## 输出

列出风险、测试层级、具体文件/场景、为何足够、不会测试什么、运行命令和需要的真实验证。完成后由 `verify-modular-change` 对账。
