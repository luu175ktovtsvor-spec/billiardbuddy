---
name: change-cross-service-api
description: Change contracts between the desktop app, gateway, relay, and dataeye with backward compatibility, secure secret boundaries, and an explicit rollout order. Use for remote endpoints, auth headers, quotas, provider adapters, async jobs, telemetry ingestion, deployment configuration, and server-client protocol migrations.
---

# 跨服务接口变更

默认旧版桌面客户端仍在运行。远程服务不能依赖客户端与服务器同时升级。

## 执行流程

1. 列出部署单元、调用方向、认证方式、超时、重试和数据敏感级别。
2. 定义版本化契约和兼容窗口；优先新增字段/端点，服务端双读，客户端切换后再删除旧协议。
3. 保持真 provider key 只在 gateway/relay；桌面端只持 app token，响应和日志不得泄露 provider 标识或密钥。
4. 慢生图保持 submit/poll；幂等提交、任务 TTL、重启丢失语义和失败状态必须明确。
5. dataeye 上传保持 gzip、幂等键、可吊销 token 和脱敏；Schema 变化同时考虑 raw 层重解析。
6. 写明发布顺序、回滚方式、功能开关和最低兼容客户端版本。

## 测试与发布

- 使用假 upstream 覆盖鉴权、限流/配额、成功透传、上游失败、超时和旧请求。
- 先部署向后兼容的服务器并验证健康检查，再发布客户端；观察稳定后才清理旧契约。
- 环境变量和部署文档与代码同次更新，但绝不把真实密钥写进仓库或测试输出。
