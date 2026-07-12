---
name: release-desktop-safely
description: Prepare, build, verify, publish, monitor, and roll back the current Bun, React, and Electron desktop application. Use for version bumps, tags, Windows or macOS installers, update channels, bundled sidecars and assets, signing, release smoke tests, staged rollout, or any request to ship a build to users.
---

# 桌面发布与回滚

发布是独立工程变更，不把“本机能运行”当成安装包可发布的证据。当前权威代码栈只有 `ts/`。

## 发布硬闸

1. 工作树范围明确，版本变更与发布说明对应一个可回滚批次。
2. `bash scripts/quality_gate.sh` 全绿；不得跳过失败项打 tag。
3. 目标平台重新构建 React、Electron main/preload 和该平台 sidecar，再由 electron-builder 出包。
4. 先执行 `bun run e2e:backend` 和 `bun run e2e:desktop`，再在目标平台干净环境安装并验证：启动、sidecar 健康、基本对话、审批/文件路径、关键产品页和退出清理。
5. 校验包内 bundled Skill/command/agent、资产下载清单、白标、密钥边界、版本和更新元数据。
6. 写明发布渠道、兼容窗口、观察指标、暂停条件和回滚版本。

## 当前项目口径

- Windows 工作流 `.github/workflows/desktop-build-win.yml` 只构建和上传 CI artifact；在更新渠道、版本策略和签名完成前，不自动推送给用户。
- macOS 未签名/公证时只用于开发和受控测试，不宣称可公开自动更新。
- gateway、relay、dataeye 契约变化先发布向后兼容服务器，再发客户端，最后清理旧协议。
- 真密钥只由受保护环境注入，不写仓库、artifact 名称、日志或发布说明。

## 回滚

保留上一可用安装包和对应提交；远程协议保留兼容窗口；数据迁移必须可重复或可逆。发布后若启动、模型出口、数据安全或更新链路异常，先停止扩大分发，再回滚客户端或关闭功能开关。

## 最终记录

记录提交、版本、平台、artifact、质量门结果、安装冒烟、已知限制、发布范围、监控结果和回滚入口。未实际发布时明确写“仅构建，未发布”。
