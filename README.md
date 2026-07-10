# 球房运营 AI 助手 · 桌面版

> 📌 状态:✅现行 · 最后核对 2026-07-10

## 这是什么

装在用户自己电脑上的**通用本机 AI Agent 桌面软件**——一句话 → AI 自己调工具把事办完(读写本机文件、跑命令、上网查抓、生图、剪视频、列清单、派子代理)。内核对标 cc-haha(`~/Desktop/cc-haha-ref`,标准 coding-agent 循环:think → 调工具 → 结果回灌 → 再推理),全方位抄、不做阉割版。

**台球房运营只是一个可 `@挂载` 的领域知识包**(`billiards`),用户在输入框选"台球运营专家"才挂;默认不挂就是个通用电脑助手。

形态 = 全本地 + 免登录单用户 + 全内置 key(走网关藏 key、白标)+ 真 Agent(ReAct 循环 + 权限五档 + 审批闸只卡对外/不可逆/花钱)。

## 当前技术栈与目录

**唯一代码栈 = `ts/`**(Bun/TS 内核 + Electron 壳)。老 Python 线(`server/`/`web/`/`desktop/`)已整体退役删除,不是历史包袱、是彻底不存在了。

```
ts/         唯一代码栈:Bun/TS 内核(cc-haha 标准 coding-agent 循环)+ Electron 桌面壳
            ts/src/harness(循环) · permissions(权限/审批) · tools(文件/命令/搜索) · sandbox/workspace(护栏)
            · hooks · skills · commands · tasks(子代理/后台) · mcp · plugins
            · context(压缩恢复) · model/proxy(provider/OpenAI 兼容) · media(生图/真实素材剪辑) · server(Bun.serve API)
            · desktop(Electron 主进程 + 前端渲染层)
gateway/    模型 key 收拢网关(国内服务器总闸):客户端只带 app 令牌,真 key 在服务器,三层阀门限流+藏 key
relay/      美国中转(生图等慢调用异步 submit/poll,绕过跨境长连接掐断)
dataeye/    用户数据接收端 + 看板(Bun/TS,非 Python)
```

## 快速开始(开发)

```bash
bash scripts/test.sh               # = cd ts && bun test + bun run typecheck
cd ts && bun test                  # 全量单测(发现 ts/**/*.test.ts)
cd ts && bun test src/harness/loop.test.ts   # 跑单文件
cd ts && bun run typecheck         # tsc --noEmit
cd ts && bun run build:sidecar     # bun build --compile 出本机 sidecar 二进制
cd ts && bun run smoke:sandbox     # 离线 smoke(sandbox/sqlite/native/model/agent-tools)
cd ts && bun run desktop:dev       # Electron 壳拉起 sidecar(需先 build:sidecar)
cd ts && bun run desktop:dist      # electron-builder 出安装包(mac dmg / win nsis)
```

老 `server/`(FastAPI/pytest)、老 `web/` vitest/tsc、`desktop/` 拉 Python 的 dev 流程、`scripts/build_coupling_map.mjs` 均已退役,不是现役命令。

## 文档去哪找

- **架构/规范/铁律/现状与待办** → 根目录 [`CLAUDE.md`](./CLAUDE.md)(唯一入口,最高优先级,任何新会话先读这份)
- **架构地图/状态总览** → [`docs/当前架构与状态-总览.md`](./docs/当前架构与状态-总览.md)(定位/内核/存储/桌面壳/网关/媒体能力/今日进度/在建方向)
- **文档总索引**(按主题分类的全部文档)→ [`docs/README.md`](./docs/README.md)
- **`ts/` 内核详细规约** → `ts/CLAUDE.md` + `ts/AGENTS.md`

## 关键边界(铁律,详见 CLAUDE.md)

- **全内置 key**:内置 owner 的模型 key,走网关藏 key、白标,用户零配置开箱即用。
- **POS 只读**:不做收银/计费/灯控/会员充值系统,只读老板导出的报表做诊断。
- **不自动群发/私信/平台发布**:对外或不可逆动作一律走审批闸,人确认后执行;生图不弹审批直接出图。
- **行业真实但守红线**:台球知识库贴行业真实运营逻辑,但硬线是不营销实际性交易、不帮刑事级犯罪、未成年保护。
