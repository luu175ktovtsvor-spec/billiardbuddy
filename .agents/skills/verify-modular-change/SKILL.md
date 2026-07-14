---
name: verify-modular-change
description: Verify a completed modular change against its declared ownership, contracts, consumers, tests, runtime behavior, compatibility, and documentation. Use after any code implementation or refactor, before declaring completion, committing, packaging, or releasing.
---

# 模块化验证收尾

回到开工前的改动说明逐项验收，不用“测试绿了”替代真实行为验证。

## 验证矩阵

1. 范围：`git diff` 是否只涉及声明的主责模块和必要消费者？是否误改用户已有内容？
2. 契约：生产者、所有消费者、运行时 Schema、错误和旧格式是否一致？
3. 后端：相关单元/契约/集成测试和 `bun test` 是否通过？
4. 前端：renderer typecheck、reducer/归一化测试、加载/失败/空状态是否通过？
5. IPC：main/preload/desktopHost 三层和 `desktop:build` 是否通过？
6. 跨服务：旧请求、鉴权、失败、部署顺序和回滚是否验证？
7. 运行面：真启动、真调用接口或真点用户路径，记录实际观察结果。
8. 文档：只有架构、部署、现行状态确实变化时才更新对应唯一真相源；删除被取代的旧口径。
9. Skill：若新增/删除/改名模块，或连接、部署、验证流程变化，同次执行 `maintain-project-skills`；普通内部实现不更新。
10. 新文件：复查新增文件内容和归属；密钥扫描必须覆盖已跟踪及未跟踪且未被忽略的文件。
11. 机械质量门：运行 `bash scripts/quality_gate.sh`；任何失败都不能用文字说明代替修复。仅开发中快速反馈可用 `--quick`，提交/发布前跑完整模式。

## 项目命令

开发中按影响范围选择；声明完成、提交或发布前统一运行：

```bash
bash scripts/quality_gate.sh
```

涉及后端 Agent 链路时增加 `verify-backend-e2e`；涉及 UI 时增加 `verify-desktop-e2e` 的真实页面/Electron 验证；涉及发布时执行 `release-desktop-safely`。

`quality_gate.sh` 会统一发现 `gateway/*.test.ts`，新增 gateway 责任模块时测试文件必须放在该目录并使用 `.test.ts` 后缀。

## 最终报告

报告主责模块、实际修改、契约变化、运行过的命令及结果、真实观察、未验证项和剩余风险。任何命令未运行或失败都要明确说明。
