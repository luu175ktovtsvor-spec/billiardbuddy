# 台球运营管家 · 桌面端（Electron）

> **全本地架构**：一个安装包 = Electron 壳 + 打包的 Next.js 前端 + 打包的本地后端 + 本地原生层(ffmpeg 剪辑/截图/TTS/文件选择)。全跑在用户电脑上,门店自带 API key 直接调大模型,不依赖云服务器。
> 计划见 `docs/plans/桌面AI-Agent-架构与开发计划-2026-06-18.md`。分支 `feat/desktop-agent`。

## 目录
```
desktop/
  src/
    main.js      # Electron 主进程:开窗口、加载前端、注册 IPC、(后续)起本地后端 sidecar
    preload.js   # contextBridge 白名单 → window.electron.{info,video,files,...}
    video.js     # 剪辑层:ffmpeg-static + spawn(裁剪/拼接/竖屏/烧字幕/水印/变速)
  package.json   # Electron + electron-builder + ffmpeg deps + 打包配置(asarUnpack 二进制/worker)
```

## 开发运行（dev,前后端分开跑）
全本地正式形态是"一个包起全部",但开发期分开跑最快:
```bash
# 1. 后端(本地 SQLite)
cd server
DATABASE_URL="sqlite+aiosqlite:///$(pwd)/billiards_local.db" uv run uvicorn main:app --port 8000

# 2. 前端(连本地后端)
cd web
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm dev   # → localhost:3000

# 3. 桌面壳(加载本地前端)
cd desktop
npm install            # 装 electron / electron-builder / ffmpeg-static
DESKTOP_APP_URL=http://localhost:3000 DESKTOP_DEVTOOLS=1 npm run dev
```
## 打包（分发）

三步：① 打后端(PyInstaller) ② 出前端(standalone)并组装 ③ electron-builder 出包。

```bash
# ① 后端 → resources/backend/billiards_backend/（PyInstaller onedir，含加密知识库 prompts.enc）
#    脚本会自动：生成一次性 Fernet key → 用 Node 加密 prompts/ 成 prompts.enc → 把 key 烘进入口 → 打包 → 复位入口
cd server && uv add --dev pyinstaller   # 仅首次
cd desktop && npm run build:backend

# ② 前端 standalone：API_PROXY_URL 烘进 server.js（前端走相对路径同源 → server.js 反代到本地后端 8077，零跨域）
#    ⚠️ 别同时跑 web 的 next dev（共用 .next 缓存会冲突）
cd web && API_PROXY_URL=http://127.0.0.1:8077 pnpm build
cd desktop && npm run build:frontend    # 组装 → resources/frontend/app/（server.js + .next/static + public）

# ③ 出安装包
cd desktop && npm install               # 仅首次
npm run build:mac                        # → dist/台球运营管家-<ver>-arm64.dmg（约 256MB）
```

**端口/连法（已固定，简单可靠）**：后端 127.0.0.1:8077，前端 127.0.0.1:3100。前端用相对 API 路径，
Next.js standalone 的 rewrites 把 `/api/v1/*`、`/uploads/*` 反代到后端——浏览器视角同源、零 CORS。
可用 env 改：`DESKTOP_BACKEND_PORT` / `DESKTOP_FRONTEND_PORT`（改了要同步重打前端，反代目标是烘进 server.js 的）。

**护城河**：安装包里【没有】明文 `prompts/` YAML，只有加密块 `prompts.enc`（运行时用烘进可执行的 key 解密，
日志会打印「知识库已加载：N 模板（来源：加密块）」；当前 prompt YAML 为 159 个模板。`server/prompts.enc` 每次构建用新 key 重生，已 gitignore 不入库。

**Windows 包**：macOS 上【产不了】原生 `.exe`（electron-builder 的 nsis 需 Windows 机或 wine）。
Win 包请在 Windows 机器上执行同样三步（`npm run build:backend` 会用本机 PyInstaller 产 `.exe`，
`npm run build:win` 出 nsis 安装器）。本仓库 backend.js 已按平台选 `billiards_backend.exe`，无需改代码。

签名：mac 需 Apple Developer($99/年)+notarytool；win 需 EV 证书或 Azure Trusted Signing。
当前 build 配置 `identity:null`（不签名），内测用户首次打开需右键「打开」放行（Gatekeeper）。

## 边界
- 当前不内置平台发布 RPA;生图/生视频/剪辑产物只生成给用户检查、保存或导出。
- 不做个人微信自动群发(封号红线);不帮经营/组织级犯罪;POS 只读。
- web 云端版(main 分支)完全不受影响。
