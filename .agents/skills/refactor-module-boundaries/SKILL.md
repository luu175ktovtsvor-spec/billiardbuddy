---
name: refactor-module-boundaries
description: Refactor oversized files and misplaced responsibilities into explicit module boundaries while preserving observable behavior and contracts. Use when splitting server/index.ts, chatStore.ts, gateway/app.ts, route tests, feature folders, or dependency cycles, and when the goal is structural rather than a product behavior change.
---

# 模块边界重构

重构批次不得同时偷偷改变产品行为。先用特征测试锁住现状，再移动责任。

## 拆分判据

满足任意两项再拆：有独立业务词汇；有独立状态或生命周期；有独立外部契约；可独立测试；变化原因与邻近代码不同；已有多个消费者。

不要仅因文件超过某个行数就造新抽象，也不要把所有东西塞进含糊的 `utils`、`common` 或 `manager`。

## 执行流程

1. 记录现有公共入口、依赖方向和行为测试。
2. 选一个责任切片，先提取无状态函数，再提取服务/路由，最后移动状态和生命周期。
3. 保持旧入口委托新模块，确保每一步可测试、可回滚。
4. 禁止循环依赖和跨模块深层导入；模块只暴露明确的公共入口。
5. 同步拆分对应测试文件，使测试跟随责任模块，而不是继续集中在巨型测试中。
6. 每个小批次跑相关测试；结束后跑全量回归和运行验证。
7. `scripts/quality/architecture-baseline.json` 只用于阻止已知巨型文件继续增长；拆分后同步下调基线，不得调高数字绕过检查。

## 当前优先对象

- `ts/src/server/index.ts`：只保留依赖组装、路由注册、生命周期。
- `renderer-react/src/stores/chatStore.ts`：拆 transport、纯事件 reducer、commands/actions、view state。
- `gateway/app.ts`：拆 config/auth、quota/rate-limit、provider adapters、usage store、routes。

若重构中发现必须改契约，暂停结构批次，另开共享契约变更处理。
