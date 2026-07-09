# ts/desktop — 桌面壳 plumbing

> W1 立项脚手架只做「Electron 会走的那条 spawn 链」的**起步版 + 证明**;完整 Electron 壳(BrowserWindow / IPC / 首启 seed / 内置资产 / 打包 / 自动更新 / sticky 端口 / 日志捕获)是 **W13**,照 cc-haha `desktop/` plumbing 重搭。

## W1 已建 + 已验(真跑过)
- `electron/services/sidecarManager.ts` — 起步版原语:`reserveServerPort`(固定→随机)/ `waitForServer`(TCP 轮询)/ `spawnSidecar`(`node:child_process`,缺二进制清晰报错)/ `killSidecar`(win `taskkill /T` 防孤儿 · 其余 `child.kill`)。用 `node:` API,Node(electron)+ Bun(测试)双运行时都能跑。
- `sidecars/backend-sidecar.ts` — 合并 sidecar 入口(起步只 `server` 模式):解析 `--host/--port` → `startServer()`。
- `scripts/build-sidecar.ts` — `bun build --compile` 出本机单文件二进制 + **macOS ad-hoc 重签**(避坏签名 SIGKILL)。全平台矩阵是 W13 CI。
- `integration/sidecar.integration.test.ts` — 端到端证明:reserve 端口 → spawn Bun sidecar → `waitForServer` → `GET /health` 200 → `killSidecar` → 端口释放。
- **真机验过**(2026-07-06,macOS arm64):`bun run build:sidecar` 出 61MB `Mach-O arm64` 二进制,ad-hoc 重签后**不被 SIGKILL**,跑起来 `/health` 返 `{"ok":true}`、`/agent/hello` 推出完整 SSE hello 循环。

## 本地怎么起后端(现在就能用)
```bash
export PATH="$HOME/.bun/bin:$PATH"   # 让 npm 脚本里的 bun 可寻址
cd ts
bun run dev:server                    # 解释执行入口(快,开发用)
# 或验编译产物:
bun run build:sidecar
./desktop/binaries/backend-sidecar-<triple> server --host 127.0.0.1 --port 8850
```

## W13 要接的 Electron 主进程(参照,别现在建)
W13 的 `electron/main.ts`(Node)复用**同一个 `sidecarManager`**拉起编译出的二进制,再开窗口连它:
```ts
import { app, BrowserWindow } from 'electron'
import { reserveServerPort, waitForServer, spawnSidecar, killSidecar } from './services/sidecarManager'
// app.whenReady() → port = reserveServerPort(...) → spawnSidecar({command: 二进制路径, args:['server','--host',h,'--port',p]})
//   → waitForServer(h,p) → new BrowserWindow().loadURL(前端地址,反代到后端)
// app.on('before-quit') → killSidecar(child, true)
```
W13 另需(照 cc-haha):IPC 通道 · 首启建作品夹 + `BILLIARDBUDDY_LOCAL=1` seed · 内置资产 `asarUnpack`(whisper `.node`/ffmpeg/sharp/bge-m3 当 sidecar 文件,别指望进单二进制)· electron-builder(dmg/nsis)· electron-updater · 完整端口策略(固定→sticky→随机)+ 启动日志捕获。
