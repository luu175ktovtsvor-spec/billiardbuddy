---
name: change-backend-module
description: Implement Bun and TypeScript backend changes inside the owning module while keeping transport, application orchestration, domain logic, storage, and external adapters separated. Use for routes, services, agent runtime, tools, permissions, tasks, media, providers, workspace, and persistence changes that preserve or intentionally manage contracts.
---

# 后端模块开发

保持依赖方向：`route/transport -> application service -> domain -> adapter/store`。领域代码不得反向依赖 HTTP、Electron 或 React。

## 执行流程

1. 判断属于 A 线 Agent 内核还是 B 线确定性产品功能。
2. 找到现有主责模块、服务接口和测试；优先扩展现有抽象。
3. route 只做解析、鉴权/权限、调用服务和响应映射；业务分支放入服务或领域模块。
4. adapter 封装文件、进程、网络、provider 和第三方 SDK；通过依赖注入保持可测。
5. 若外部字段、事件或错误变化，使用共享契约 Skill；否则用测试证明契约未变。
6. 为领域规则写单元测试，为路由写薄契约测试，为关键跨层路径写集成测试。

## 项目约束

- 不继续向 `ts/src/server/index.ts` 增加可独立成域的大段逻辑；HTTP 边界进入 `ts/src/server/routes`，应用编排进入 `ts/src/server/services`，领域逻辑留在对应主责目录。
- 后端不得依赖 renderer；跨层类型只从 `ts/shared/contracts` 输出，route 在运行时解析不可信输入。
- 用户要求对照外部 Agent 时，直接读取其当前源码或软件证据并写行为测试；不预设固定上游。产品功能不织进模型循环。
- 本地状态使用 JSONL/JSON 和原子写入，不引入 SQL。
- SSE 使用 async generator 并关闭 Bun 请求超时；原生 `.node` 能力遵守 sidecar 边界。
- 权限、沙箱、路径、凭据和输出白标属于安全边界，修改时补刁钻失败用例。
