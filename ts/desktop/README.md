# `ts/desktop` 桌面运行时

`ts/desktop` 负责 Electron 主进程、preload IPC、React renderer、Bun sidecar 生命周期和桌面安装包资源装配。

## 当前启动链路

```text
bun run desktop:dev
  -> vite build desktop/renderer-react
  -> bun build Electron main/preload
  -> Electron main 启动本地 Bun sidecar
  -> BrowserWindow 加载 desktop/renderer-dist/index.html
```

React renderer 是唯一桌面界面。开发态只有显式设置本机回环地址的 `ELECTRON_RENDERER_URL` 时才加载 Vite 开发服务器；打包态始终加载包内 `renderer-dist/index.html`。sidecar 只提供 API、WebSocket 和本地能力，不提供桌面静态页面。

应用没有假数据预览模式。设计走查和 Computer Use 都必须连接真实 sidecar，不允许通过 URL 参数跳过启动链或注入示例会话。

## 主要目录

- `electron/`：BrowserWindow、菜单、IPC、窗口与 sidecar 生命周期。
- `renderer-react/`：React 源码和 Vite 配置。
- `renderer-dist/`：`bun run ui:build` 生成的 renderer 产物。
- `sidecars/`：开发态 Bun sidecar 入口。
- `scripts/build-sidecar.ts`：生成随安装包交付的本机 sidecar 二进制。
- `integration/`：sidecar 进程与端口生命周期集成测试。

## 常用命令

```bash
cd ts
bun run desktop:dev
bun run build:sidecar
bun run desktop:dist
```

`desktop:dist` 负责构建 React renderer 和 Electron main/preload；制作安装包前还需要先生成目标平台的 sidecar 二进制。安装包文件清单以 `electron-builder.yml` 为准。
