# BilliardBuddy Desktop

React + Vite renderer 与 Electron 桌面宿主。Electron main 负责启动本地 sidecar、窗口、preload IPC、Browser/Preview、终端和系统能力；renderer 通过受限 API 使用这些能力。

## 开发

```bash
bun install
bun run dev
```

运行 Electron：

```bash
bun run electron:dev
```

## 验证

```bash
bun run test -- --run
bun run lint
node ./node_modules/vite/bin/vite.js build
```

完整 `bun run build` 会重建 preview agent；处理用户已有的 `src-tauri/resources/preview-agent.js` 修改时，必须先确认许可内容不会被生成脚本覆盖。

## 打包

```bash
bun run electron:package:dir
```

对外安装包必须另行完成平台签名、公证、解包检查和真机冒烟；构建成功不等于可发布。
