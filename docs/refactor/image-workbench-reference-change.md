# 图片工作台画布、MediaReasoning 与候选版本：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第二轮生图工作台的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

图片创作继续由独立 `MediaProject` 持有，聊天 Harness 不参与。一次生成先持久化同一 Operation 的图片 Job，再由 MiMo V2.5 `MediaReasoning` 整理可编辑 Brief；图片 provider 只接受 provider-neutral ImageOperation 并返回候选。候选字节先落为项目 Asset 与不可变 Version，再由 MiMo 做可校验、非权威的视觉质检。质检失败不能抹掉已经生成并校验的候选。

renderer 的主工作区改为真实 Canvas、图层选择、候选/版本胶片条和比较视图。确定性文字排版与本机放大分别提交新 Version；局部重绘在画布上产生与基础版本同尺寸的透明 PNG mask，Product Server 校验并保存为项目内 mask Asset 后才提交 ImageOperation。前端任务进度只消费持久 MediaJob/Event cursor，不恢复 provider 轮询。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| InvokeAI commit `68b90174aafebbbba45d14b049fb6852271c76a8`：`invokeai/frontend/web/src/features/controlLayers/components/InvokeCanvas/InvokeCanvasComponent.tsx`、`CanvasWorkspacePanel.tsx`；Apache-2.0 | 直接证据。Canvas 是独立工作区的主表面，工作区面板承载画布交互，不是聊天消息中的一次性图片卡片。 | 用户需要在项目里查看、选择和继续编辑真实作品，而不是反复发送文字并猜测哪张图是当前结果。 | `ts/desktop/src/components/media/ImageWorkbench.tsx` 原先以单张 `<img>` 预览为主，已有生成、编辑、放大和文字入口但没有一级 Canvas/图层选择。 | Product Server 的 MediaProject/Asset/Version；renderer 只保留缩放、当前选中图层和正在绘制的 gesture。 | 独立实现适配本项目的 Canvas surface、图层列表、缩放、当前版本与候选比较；不引入 Invoke Redux、Konva manager 或完整前端 bundle。 | 图片加载失败不产生 Version；切换项目或 current Version 时清理 renderer 草稿、蒙版和选择。已保存版本仍由服务端重开恢复。 | `ImageWorkbench.test.tsx` 验证 Canvas、图层、候选选择、质检、局部重绘蒙版和确定性排版入口；桌面类型检查与组件测试。真实桌面缩放、HiDPI 指针和安装包旅程仍需执行。 |
| 同 commit：`features/controlLayers/store/canvasSlice.ts`、`types.ts`、`canvasStagingAreaSlice.ts`、`canvasWorkflowIntegrationSlice.ts`、`konva/CanvasManager.ts` 及实体 adapter | 直接证据。画布对象以明确实体存在；staging area 保存待选择结果；工作流集成把当前画布状态编译成生成输入，manager 负责画布交互而非作品持久真相。 | 候选、图层、mask 和当前版本不能都挤在一张可覆盖的图片或 React 临时数组里。 | `ts/shared/contracts/media.ts`、`MediaProjectService.commitImageVersion/startImageOperation`、`ImageWorkbench.tsx`。 | Asset 保存不可变字节；Version 保存父版本、版本种类、尺寸和文字图层；Project 只移动 current pointer；mask 是 Operation 引用的项目 Asset。 | 保留现有统一媒体仓储，补 Canvas/图层投影与画布内蒙版；候选继续映射为独立 Asset/Version，不复制 Invoke 的内部实体类型。 | mask 必须为 PNG 且尺寸严格等于 base Version；文字排版不能改变画布尺寸或漏掉 Brief 的 `exact_text`；任一校验失败不写新 Version。撤销/重做只移动 current pointer。 | 服务测试覆盖生成、编辑、局部重绘、mask 尺寸、文字、放大、父版本、选择/回滚与导出；组件测试覆盖画布蒙版控件和版本切换。 |
| 同 commit：项目 snapshot/save/load 相关实现与 `useEnqueueCanvas.ts` | 直接证据。画布项目可保存/恢复；enqueue 使用已编译的当前画布/工作流状态创建后端队列项，前端不是执行终态。 | 应用重开后要知道同一操作处于理解、提交、生成还是提交资产阶段，不能在 MiMo Brief 调用期间只有一个按钮 loading。 | `MediaProjectService.submitImageProject/performPersistedImagePipeline/performImageSubmission`、MediaTask/Event journal、`mediaWorkbenchStore.ts`。 | 先落盘的 MediaTask 是 MediaJob 真相；同一 `operation_id`、幂等键、上游 task id、provider receipt 与单调事件贯穿完整操作。 | 在任何 MediaReasoning/图片 provider 调用前保存 Job 和 Project 指针；把 Brief 完成写成 Job checkpoint，再提交同一 Operation；renderer 继续只读 Event cursor。 | Brief 失败在付费图片生成前终止并保存安全终态；重启时无远端 task id 的 Job从 checkpoint 继续同一操作；提交结果未知只查询/复用原幂等键，不自动创建第二次远程任务。 | 服务测试在阻塞 MediaReasoning 时直接读取已落盘 Job/Event，并验证释放后仍是同一 Job/Operation；已有崩溃恢复、未知结果、幂等复用和迟到结果测试继续通过。 |
| 重构合同固定模型边界与 BilliardBuddy 当前 Gateway 链：`ts/shared/product/providerContracts.ts`、`gateway/providerRegistry.ts`、`gateway/app.ts`、`gateway/modelCapacity.ts`、`gateway/usageBudget.ts`、`ts/src/server/services/imageReasoning.ts` | 直接合同与当前代码事实。原 `/v1/media/reasoning` 复用了 VisualEvidence 注册和用量，MiMo 账号容量只有旧 `native/vision` 名称，不能证明工作台与聊天看图隔离。 | 长视频/图片规划不能挤占聊天 VisualEvidence；工作台也不能借聊天端点或 DeepSeek 运行。 | 上述 Gateway、能力快照、部署 manifest、负载测试与图片服务。 | Provider Registry 的 `MediaReasoning` 条目；Gateway 独立 endpoint、operation receipt、usage budget 与 `media/vision` 硬容量分区。 | 注册 MiMo V2.5 `MediaReasoning`；端点独立计量；容量 lane 改为 `media` 与 `vision`；图片 Brief/质检只请求 `/v1/media/reasoning`，不经过 DeepSeek。 | 未配置、超时、非法 schema 或预算耗尽时 fail closed；Brief 失败不提交图片生成，质检失败保留已校验候选并给出非阻断提示。 | Gateway 路由/预算/容量测试验证两种能力分离；图片服务测试断言模型、endpoint、operation id、硬事实保护和候选质检。真实 MiMo 账号容量与线上返回仍需部署后验证。 |
| BilliardBuddy 当前图片执行链（2026-07-26）：`imageBrief.ts`、`imageReasoning.ts`、`MediaProjectService`、`media.ts`、`mediaWorkbenchStore.ts`、`ImageWorkbench.tsx` | 直接当前代码事实。Host 已能提取用户硬事实与精确文字，Relay 已提供持久图片 task；缺口是工作台专用 MiMo Brief/质检、一级 Canvas/图层、画布 mask，以及让理解阶段进入同一权威 Job。 | 模型建议不能覆盖价格、日期、品牌等硬事实，也不能把“建议文字”冒充已经写入图片；候选必须能比较、选择、继续编辑与导出。 | 上述完整链及共享媒体合同/API/测试。 | Host Brief 的 `confirmed_facts`/`exact_text`；MiMo 只补充可编辑建议；Asset/Version/Job 是产物和运行真相。 | schema 校验并合并 MiMo 建议但不覆盖 Host 硬事实；候选落盘后做 best-effort QA；公开 API 只投影 Version、QA 与安全 Job 字段。 | 非法 MiMo JSON、Reference 越界/替换、mask 尺寸、版本 CAS、迟到结果和提交中断全部 fail closed 或恢复同一 Operation；本地候选落盘后 QA 故障不回滚产物。 | server、Gateway、shared contract、API、desktop store/component 定向测试与全量 gates；真实 GPT Image 2/Seedream/MiMo 用户旅程和安装包资产审计单列。 |

## 不采用的做法

- 不把 InvokeAI 的 Redux、Konva manager、模型执行器或 bundle 整体作为运行时依赖；只按固定源码验证过的状态边界在现有媒体仓储上实现。
- 不让 MiMo 直接写 `confirmed_facts`、`exact_text`、mask、Version 或导出终态；模型输出只是经过 schema 校验的建议和质检。
- 不在 renderer 恢复 Relay/provider 轮询；任务重连继续使用 Product Server 的持久 Job/Event cursor。
- 不因候选视觉质检暂时失败而删除或重跑已经落盘的图片；重新生成必须是新的用户意图。
- 不把本机 Canvas 渲染成功当作已持久化作品；只有 Product Server 校验并写入 Asset/Version 后才是可恢复版本。

## 本次验收边界

本次定向测试证明图片工作台的 MediaReasoning/图片生成边界、先持久化 Job、候选 Asset/Version、画布蒙版、文字图层、版本选择与失败恢复路径成立。它不证明真实 MiMo、GPT Image 2、Seedream 上游当前可用，也不证明 HiDPI 画布手势、4K 大图性能、安装包资源和完整桌面用户旅程；这些仍需按重构合同在真实部署和安装包上分别验收。
