# 视频时间线状态机与节目预览：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第三轮视频工作台的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

视频工作台保留现有 `MediaProject`、不可变 `Timeline Version`、素材 fingerprint、场景锁和最终 FFmpeg 导出。重写 renderer 的时间线交互为小型显式状态机，使片段拖动、入点/出点裁切和播放头移动互斥且可取消；节目预览由 Product Server 启动独立 `video.preview` MediaJob，以固定 timeline version 生成低成本托管预览资产，renderer 不在主线程拼接或假装模型计划已渲染。

OpenShot 指定源码采用 GPLv3，本次只按已验证的状态/线程边界独立实现，不复制其代码。OpenCut 指定 commit 的 Timeline/Preview 只有静态占位，不作为执行内核。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| OpenShot commit `9cd2b3f3`：`src/windows/views/timeline_backend/state.py`；GPLv3 | 直接证据。`idle`、clip drag、resize、playhead、box select、keyframe 是同一状态机的互斥状态；进入/退出状态分别调用 start/finish。 | 拖片段时不能同时改变裁切点或播放头；一次指针取消不能留下半次编辑。 | `VideoStudio.tsx` 目前以按钮重排、数字输入裁切和局部 React draft 直接改数组，没有显式交互状态。 | 已保存的 `Timeline Version` 是作品真相；交互状态只保存当前 gesture 与其起始快照，commit 后才形成 draft，保存后才形成新 Version。 | 独立实现 `idle/dragging/trimming/scrubbing` reducer 与时间线组件；不复制 Qt/GPL 实现，也不引入第二个项目 Store。 | `pointercancel`/Esc 回到起始快照；场景锁和 busy 状态禁止进入 gesture；保存时继续由 base revision + timeline version CAS 拒绝陈旧写入。 | reducer 转换矩阵、拖动重排、双端裁切、播放头、锁定场景、取消和陈旧保存测试。 |
| OpenShot 同 commit：`src/windows/preview_thread.py` | 直接证据。Player 在独立 `QThread` 运行；seek 请求经锁只保留最新值；父对象可 Stop/kill 并等待线程退出；播放位置/模式以信号回 UI。 | 用户移动播放头或编辑时间线时，界面不能被解码/渲染阻塞，也不能显示被新版本取代的迟到预览。 | 当前工作台只有素材 `<video>` 和最终导出，没有由当前 Timeline Version 生成的节目预览。 | `video.preview` MediaJob 保存输入 revision/timeline version、进度、取消和预览资产；Project 只在同一 version 仍为 current 时发布预览指针。 | 复用现有 FFmpeg 进程 runner、Task/Event cursor 和资产路由，新增独立可取消预览 Job；renderer 只播放已校验的托管预览；托管 MP4 资产响应真实 `video/mp4` 与 Range。 | 新 timeline version 使旧预览过期；迟到结果校验 version 后丢弃并清理临时文件。崩溃后若未原子发布则明确失败，可重新生成；取消后不发布资产。 | 独立进程、取消、迟到结果、服务重启、内容 hash、临时文件清理、Range 播放和事件投影测试；真实素材旅程另行执行。 |
| OpenShot 同 commit：`src/classes/project_data.py` | 直接证据。项目数据跟踪 `has_unsaved_changes`，禁止直接 `set()`，变更需经过 UpdateManager；读取返回副本。 | 用户必须分清“尚未保存的时间线草稿”“已保存 Version”和“该 Version 的节目预览”。 | `VideoStudio.tsx` 已有 draft 与保存提示；`MediaProjectService.updateVideoTimeline` 已创建不可变 Version。 | Project revision + current timeline version；renderer draft 不是持久真相。 | 保留现有 CAS 保存链，在 UI 明示草稿/已保存/预览过期；preview 输入必须引用已保存 timeline version。 | 用户从脏草稿发起预览时先保存成新 Version，再用返回的 revision/version 启动预览；保存冲突不创建 Job。旧预览仍可查看但明确标为旧版本，直到新预览发布。 | draft dirty、保存、版本冲突、预览过期和项目重开测试。 |
| OpenCut commit `4d8c49ed`：`apps/desktop/src/panels/timeline.rs`、`preview.rs` | 直接证据。两个 Render 只输出居中的 `Timeline`/`Preview` 静态文字与分栏样式，没有状态机、播放或渲染实现。 | 不能把一个好看的空面板当成已经具备剪辑能力。 | `VideoStudio` 已有真实素材、timeline、场景与导出链，不能退回占位布局。 | BilliardBuddy 自己的 Project/Version/Job。 | 只保留“素材/源预览/节目预览/时间线/导出”分区思想，不移植占位实现。 | 任何能力都必须由真实后端 Job/Asset 支撑；无预览资产时显示可执行空态，不显示假播放器。 | UI 测试证明按钮调用真实 API，预览 URL 来自已发布 Asset。 |
| BilliardBuddy 当前生产链（2026-07-26）：`VideoStudio.tsx`、`mediaWorkbenchStore.ts`、`media.ts`、`MediaProjectService.updateVideoTimeline/renderVideo` | 直接当前代码事实。素材预览由浏览器 video 解码；timeline 有增删、重排、拆分和数字裁切；保存生成 Version；最终导出是持久 Task，但没有 preview Task/Asset。 | 用户能编辑并导出，却不能在导出前观看当前编排的节目结果；简化按钮也不能表达真实拖动/裁切 gesture。 | 上述完整链路及测试。 | `MediaProjectService` 是唯一写入口；MediaTask/Event 负责 preview Job；Timeline Version 负责编排。 | 新增 preview contract/API/service/store/UI 和纯 reducer；预览只写项目托管资产，不新增任意路径权限或 Electron IPC；最终导出、分析和聊天边界不变。 | preview 与 render 分离取消；任一失败不修改 current timeline；任务事件 cursor 继续负责重连，不新增轮询。 | server/API/store/component 纵向测试、全量 gates；真实视频素材与安装包仍是更高验收层。 |

## 不采用的做法

- 不把浏览器 `<video>` 播放某一源素材称为节目预览。
- 不在 renderer 主线程拼接、转码或读取任意本机路径。
- 不让 MiMo 文本计划写入预览或时间线终态；只有 FFmpeg 产物、hash 和 Asset 发布才算预览完成。
- 不复制 OpenShot GPLv3 源码；只按公开可验证的状态与线程边界独立实现。
- 不采用 OpenCut 指定 commit 的静态占位面板作为完成证据。

## 本次验收边界

本次完成只证明明确的基础时间线 gesture 与非阻塞节目预览链成立。多轨、转场、关键帧、音频混音、代理媒体和真实安装包性能仍需在合同后续验收中单独证明。
