# BilliardBuddy 官方网站

本目录是独立的产品介绍网站，不包含桌面 Agent、Gateway、Relay 或 Electron 的运行时代码。

网站可以介绍 BilliardBuddy 的三个独立工作面：Codex 原生 Agent、图片工作台和视频工作台；不能把它们描述成共享一份任务状态或后台自动串联的流水线。图片不会自动变成视频，Agent 也不会替代媒体项目和导出结果。

网站展示的是产品说明，不是桌面应用截图、Agent 执行证据或另一套前端实现。当前桌面 Renderer 正在重建，网站不得把尚未交付的桌面交互、云端账号体系、原生 Codex 生图或安装包下载写成已上线能力。

安装包开放、版本发布、签名和更新链接必须由桌面发行流程明确授权；`/download` 在未发布前保持关闭。

## 本地开发

```bash
npm install
npm run dev
```

## 生产构建

```bash
npm run build
```
