# 视频工作台 Gate 5/6 发布证据

本文件是受控发布前的执行清单和证据模板，不代表本分支已经完成生产 Provider、桌面安装包、macOS 或 Windows 实测。

## 本地提交门槛

从待发布提交所在 worktree 执行：

```sh
git rev-parse HEAD
cd ts
bun run test:video
bun run typecheck:server
bun run audit:source
bun run check:desktop
bun run check:electron
```

记录完整 SHA、每条命令退出码、测试通过/跳过/失败数，以及 `git status --short --branch`。上方视频测试命令包含视频 Sidecar、Video Media Relay/OSS/DashScope 合同、素材事实、编辑、完成层、IPC/grant 和 Renderer 的本地测试；其中 live OSS contract 默认跳过，不可把 skip 标为 smoke 成功。

## 受控环境前置条件

- 由运维在受控环境提供 Video Relay HTTPS 地址、短期安装 token、已批准的最小权限 OSS/DashScope 配置和可删除测试素材。密钥只位于受控 secret store 或进程环境，不能进入 Git、终端记录、Renderer、截图或回执正文。
- Relay 环境必须显式设置 `VIDEO_MEDIA_LEASE_TTL_MS` 和 `VIDEO_MEDIA_LEASE_MAX_RETENTION_MS`；后者是对象租约的绝对保留上限，范围为 60 秒至 30 天，且不得小于前者。部署校验拒绝依赖测试默认值的配置。
- 使用新的临时项目、临时 OSS 前缀和一次性桌面安装 token。不得改 Gateway、Nginx、Compose、容量策略或共享部署配置。
- 先确认 Video Relay 镜像 digest、`readyz`、受控 CJK 字幕运行时日志和清理策略；对真实模型调用先创建最小 consent 与项目预算。
- 所有测试输出必须落在临时目录，最后核对没有未确认 Operation、`outcome_unknown`、活动对象租约、暂存 sidecar 或测试进程。

## 当前共享桌面集成阻塞

Video Media Relay 镜像已对 CJK burn-in 字体做启动验证；但正式 Preview/Render 由桌面 Sidecar 的本机 FFmpeg 执行。该路径只接受绝对路径的 `VIDEO_MEDIA_SUBTITLE_FONT_DIR`，而当前共享 Electron runtime 仅注入媒体二进制目录，现有打包步骤也没有随安装包放入受控的 `NotoSansCJKSC-Regular.ttc` 与对应 fontconfig 资源。

因此，缺少该受控注入时 CJK burn-in 会失败关闭，不可将 Relay `readyz` 或本地单测视为桌面安装包的烧录成功。按本轮共享 Electron/打包边界，此分支不修改这些共享文件；后续协调集成必须先审查并打包受控字体资产、由 Main 进程仅向 Sidecar 注入目录，再执行 macOS/Windows 安装包 CJK Preview/Render smoke。

## 经批准后执行的命令

以下命令仅在明确授权的受控环境执行；本分支开发阶段不运行它们。

```sh
export RELEASE_SHA=REPLACE_WITH_COMMITTED_SHA
git rev-parse HEAD
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"

cd ts
bun run test:video
bun run typecheck:server
bun run audit:source
bun run check:desktop
bun run check:electron

# 仅在运维明确授权时，由既有发布流程构建视频相关安装包和 Relay 镜像。
# 不在这里执行 electron:package、真实 Provider smoke 或跨平台远程构建。
```

当前分支的 Gate 5/6 回归以服务端/Relay/API/IPC contract 为准：它覆盖交付意图、范围决定、分层规划、Quick Create Draft、Proposal CommandSet 接受和幂等重放。它不是已完成的桌面安装包旅程证据；在共享 Electron 集成完成并由受控环境提供安装包后，仍须执行下面的真实 Renderer smoke。

## 受控 Smoke 矩阵

| 旅程 | 必须保留的脱敏证据 | 成功条件 |
| --- | --- | --- |
| Relay 字幕运行时 | 镜像 digest、`readyz`、`video_relay_subtitle_runtime_ready` 日志 | CJK burn-in 运行时通过，未使用宿主字体回退 |
| 授权与范围 | 公开 project/operation ID、consent/budget 摘要 | 允许范围才触发远端；取消同意不发请求；额度拒绝可行动 |
| Renderer 权限 | IPC 参数摘要、Renderer 截图 | Renderer 只拿 display name、selection ID、destination grant，不含路径/URL/key |
| 事件恢复 | cursor、next_cursor、reset_required 记录 | cursor 续读不漏事件；reset 后重新读取权威 workspace |
| 取消与失败 | Operation 状态序列、用户反馈截图 | cancel 只以服务端 Operation 为准；错误提供刷新、重选素材、重新估算或续读动作 |
| 字幕/构图/音频/节拍 | 冻结 Variant Version、ExecutionPlan、预检报告 | CommandSet 形成正式版本；预检、预览和导出引用同一 Plan |
| 渲染与质量门槛 | 输出 hash、verification、post-render 报告 | blocked 不发布；warning 必须由人工精确确认后发布 |
| 清理 | OSS/lease 删除摘要、本机临时目录检查、进程检查 | 无保留测试对象、暂存文件、未知结果或测试进程 |

## 记录模板

```text
release_sha:
video_relay_image_digest:
environment:
local_checks:
  test_video:
  typecheck_server:
  audit_source:
  desktop_build:
  electron_protocol_check:
smoke:
  relay_readyz:
  authorization_and_budget:
  renderer_opaque_grants:
  event_recovery:
  cancellation_and_failure_feedback:
  finishing_execution_plan:
  output_verification_and_quality_gate:
cleanup:
  oss_or_lease_cleanup:
  local_temporary_outputs:
  processes:
unexecuted_external_gates:
  - provider_smoke
  - desktop_cjk_burn_in_packaging_and_smoke
  - macos_package
  - windows_package
```
