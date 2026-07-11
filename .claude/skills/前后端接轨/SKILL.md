---
name: 前后端接轨
description: 给桌面 app 加前端功能/按钮/面板,或改动数据链路(React renderer ↔ Electron IPC ↔ sidecar HTTP/WS ↔ ts/src 内核)时使用——先归类到五类连接模式、过接轨五问,再动手。当用户说"加个按钮/做个面板/前端接后端/改链路/前后端衔接"时触发。
---

# 前后端接轨(操作 checklist)

方法论全文(五类模式的契约位置/命门/血案案例)读 `docs/references/前后端接轨-五类连接模式与判据.md`;纪律四条在 CLAUDE.md「前后端衔接铁律」。本 skill 是动手时的执行顺序。

## 第一步:归类(选不出来=需求没想清楚)

| 这个按钮是… | 类型 | 管道 |
|------------|------|------|
| 让 AI 干活(发送/审批/插话/打断) | ① A线对话流 | WS 消息族(types/chat.ts ↔ server/index.ts) |
| 确定性产品功能(生图/剪视频/定时) | ② B线产品功能 | REST + 慢活 job 化 |
| 动 OS(选文件/打开/Finder/防休眠) | ③ 原生能力 | IPC 三层(main.ts + preload.ts + desktopHost.ts) |
| 展示数据(树/列表/预览/状态) | ④ 只读数据面 | GET + store 入口归一化 |
| 纯 UI 态(折叠/宽度/主题) | ⑤ 纯前端 | localStorage(换机丢了不心疼才允许) |

## 第二步:动手前五问

1. 契约在哪个文件?两端谁生产谁消费,没找全不动手。
2. 上下文带全了吗?(conversationId / working_dir / permissionMode / enabled_packs——对照 run 消息抄全;approve 丢 working_dir 的血案在案例库)
3. 错误契约是什么?用户点了失败看到什么话?(禁止静默失败/点了没反应)
4. 浏览器端降级了吗?(desktopHost 能力缺失时按钮不渲染,不是渲染了点不动)
5. 慢活 job 化了吗?(②类:submit→poll,依赖未就绪显示"正在准备 x%")

## 第三步:两头一起改

动了一端的字段/事件/路由/类型,同一次施工把另一端 + 共享类型(types/chat.ts)+ 归一化层改完。③类改了 electron 的 .ts 要重跑 `bun run desktop:build`。

## 第四步:收工验证

```bash
cd ts && bun run typecheck && bun test   # 双 tsconfig + 全量
```
凡涉界面:真机点一遍受影响路径(billiardbuddy-desktop-e2e 或 CDP 直驱);新连接点没测试盖到就补一条;后端改了要重启 sidecar 才生效(杀进程守护会自动用新代码重拉)。
