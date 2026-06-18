# 桌面端发布内核（publisher/）

桌面端「多平台发布内核」——用浏览器自动化（patchright）半自动发短视频/笔记。
支持 **抖音 / 快手 / 视频号 / 小红书** 四个平台，同一套协议、同一个浏览器底座。

Electron 主进程（`desktop/src/publish.js`）通过 `child_process` 调本目录的 `cli.py`，
按 **JSON-line 协议** 解析它的 stdout。本内核绝不放渲染进程，跑在独立 Python 子进程里。

> 半自动 + 人扫码 + 人点确认，走各平台**创作者后台网页**（等同真人手动发），
> **不碰任何官方"代发布"API**（资质门槛走不通 / 小红书根本没开放），规避「代发布」红线。

| 平台名（`--platform`） | 站点 | 内核文件 |
|------|------|------|
| `douyin`（抖音） | creator.douyin.com | `douyin_uploader.py` + `dy_selectors.py` |
| `kuaishou`（快手） | cp.kuaishou.com | `kuaishou_uploader.py` + `ks_selectors.py` |
| `shipinhao`（视频号·后台称 tencent） | channels.weixin.qq.com | `shipinhao_uploader.py` + `sph_selectors.py` |
| `xiaohongshu`（小红书） | creator.xiaohongshu.com | `xiaohongshu_uploader.py` + `xhs_selectors.py` |

## 文件结构

| 文件 | 作用 |
|------|------|
| `cli.py` | 入口。argparse 解析 `login`/`check`/`post`，路由到对应平台 uploader，按协议输出 JSON-line |
| `<platform>_uploader.py` | 各平台的登录/检查/发布逻辑（patchright 持久上下文）。抖音/快手/视频号/小红书各一份 |
| `*_selectors.py` | 各平台**集中选择器表**（`dy_/ks_/sph_/xhs_`）。平台改版只改这里。⚠️ 不叫 `selectors.py`（撞标准库会让 asyncio 崩） |
| `base.py` | 协议输出辅助（`emit_*`）+ patchright 浏览器底座（反检测最佳实践），四平台共用 |
| `requirements.txt` | 依赖（patchright） |

## 安装

```bash
cd desktop/publisher
pip install -r requirements.txt
patchright install chromium    # 装浏览器内核（首次必做，否则跑不起来）
```

- **强烈建议本机装有 Google Chrome**：patchright 官方推荐 `channel="chrome"`（用真 Chrome 比
  bundled chromium 更不易被风控识别）。本内核会自动探测 Chrome 安装位置；没装则自动退回
  bundled chromium。
- 真发布**必须有头**（`headless=False`），需要桌面显示器。无显示器环境只能做语法/协议自检，
  没法端到端扫码发布。

## 命令与协议

主进程注入环境变量 `SAU_SESSION_DIR`（cookie/storage_state 存放目录，按平台各一份：
`douyin.json` / `kuaishou.json` / `shipinhao.json` / `xiaohongshu.json`）。
下面把 `<p>` 换成 `douyin|kuaishou|shipinhao|xiaohongshu` 任一即可。

```bash
# 1) 扫码登录：抓二维码 → 用户扫 → 存 cookie
python cli.py login --platform <p>
#   stdout 流：
#   {"type":"status","status":"waiting","msg":"..."}
#   {"type":"qrcode","dataUrl":"data:image/png;base64,..."}   ← 给前端展示，用户扫
#   {"type":"status","status":"scanned|expired|success|error","msg":"..."}
#   成功后存 SAU_SESSION_DIR/<p>.json，退出码 0

# 2) 检查 cookie 还有效吗
python cli.py check --platform <p>
#   {"type":"result","ok":true|false}    （无 cookie 文件秒回 false、不开浏览器）

# 3) 发布（人确认后才调）
python cli.py post --platform <p> --payload /path/to/payload.json
#   {"type":"progress","stage":"upload|fill|publish","pct":0-100,"msg":"..."}  多条
#   {"type":"result","ok":true,"url":"作品链接"}  或  {"type":"result","ok":false,"error":"..."}
```

`payload.json` 形如：

```json
{
  "videoPath": "/abs/path/to/video.mp4",
  "title": "今晚台球房有活动",
  "tags": ["台球", "桌球", "约球"],
  "coverPath": "/abs/path/to/cover.jpg",
  "scheduleAt": "2026-06-20T20:00:00"
}
```

- `videoPath`、`title` 必填；`tags`/`coverPath`/`scheduleAt` 可选。
- `scheduleAt` 为合法 ISO 时间则走「定时发布」，否则立即发布。

## 本地测法

### 协议自测（不开浏览器，不联网，秒过）

不依赖真实站点/浏览器，验证 `cli.py` 对三个命令都按协议输出（四平台均已实测通过）：

```bash
# 不支持的平台
python cli.py check --platform bilibili      # → {"type":"result","ok":false,"error":"暂不支持平台：bilibili"}

# check 在没 cookie 时（SAU_SESSION_DIR 指向空目录）：四平台都秒回 false、不开浏览器（实测 ~0.07s）
for p in douyin kuaishou shipinhao xiaohongshu; do
  SAU_SESSION_DIR=/tmp/sau_empty_$p python cli.py check --platform $p   # → {"type":"result","ok":false}
done

# post 在缺视频文件时（入参校验，不开浏览器就拦下）
echo '{"title":"t","videoPath":"/no/such.mp4","tags":[]}' > /tmp/p.json
SAU_SESSION_DIR=/tmp/sau_x python cli.py post --platform kuaishou --payload /tmp/p.json
#   → {"type":"result","ok":false,"error":"视频文件不存在：/no/such.mp4"}
```

> 本机（macOS，已装 Google Chrome + patchright）实测：四平台 `login` 均能弹真 Chrome、
> 抓到真实二维码 `dataUrl`（快手 ~710 字符、视频号 ~35K 字符[iframe 内]、小红书 ~4.8K 字符）。
> 不要真扫码真发布（需真人账号）。

### 语法检查

```bash
cd desktop/publisher && python3 -m py_compile *.py
```

### 端到端（需真人抖音账号 + 显示器）

```bash
export SAU_SESSION_DIR=~/.billiards-desktop/sessions
python cli.py login --platform douyin     # 会弹真 Chrome 窗口、停在 creator.douyin.com，抓二维码
# 用抖音 App 扫码确认 → 终端打 {"type":"status","status":"success"}
python cli.py check --platform douyin      # → {"type":"result","ok":true}
# 备好一个真实 mp4，写 payload.json，再 post
```

> 调试时想看浏览器在干嘛：日志全走 **stderr**（stdout 只放协议 JSON），直接看终端 stderr 即可。
> 强制无头自检（不弹窗，仅验证流程能起来）：`SAU_HEADLESS=1 python cli.py login --platform douyin`。

## 反检测说明（为什么这么配）

patchright 官方最佳实践（v1.60 文档实测）：

- `launch_persistent_context(channel="chrome", headless=False, no_viewport=True)`
- **不要** 注入 `stealth.min.js` / `add_init_script` / 改 `user_agent`——patchright 已在底层打补丁，
  再注入反而暴露。（这一点与参考仓库 social-auto-upload 的老做法不同，本内核按 patchright 官方推荐改了。）

## 选择器来源

四平台页面选择器全部搬自 **dreammis/social-auto-upload**（12.7k★），该仓库已迁到 patchright、
在各平台真实创作者后台验证过。各平台对应上游文件：

| 平台 | 本内核选择器 | 上游来源（dreammis/social-auto-upload） |
|------|------|------|
| 抖音 | `dy_selectors.py` | `uploader/douyin_uploader/main.py` |
| 快手 | `ks_selectors.py` | `uploader/ks_uploader/main.py` |
| 视频号 | `sph_selectors.py` | `uploader/tencent_uploader/main.py` |
| 小红书 | `xhs_selectors.py` | `uploader/xiaohongshu_uploader/main.py`（**新版** UI 流程，非旧 `xhs_uploader`） |

本内核只搬"二维码登录定位 / 登录完成判定 / cookie 校验 / 视频上传控件 / 填标题正文话题 /
封面 / 定时 / 发布按钮"这几处主链路，剥掉了无关部分（商品链接、地理位置、合集、图文笔记等），
并把每处套了失效兜底（找不到控件 → 走 `emit_status`/`emit_result` 报 error，不静默卡死）。

### 小红书的特殊处理（无官方 API）

小红书**没有**开放给商家的官方"代发布"接口。社区常见的 `ReaJason/xhs` 库走的是逆向 web 签名
（`window._webmsxyw` + Flask 签名服务），灰产味重、极易触发风控封号——**本内核不走这条路**。
本内核改走 **创作者后台网页 + 人扫码 + 人点确认** 的半自动路径
（等同真人在 `creator.xiaohongshu.com` 手动发），最稳最合规，与抖音/快手/视频号三家完全同构。
小红书发的是"笔记"：本内核默认发**视频笔记**（`target=video`），上传视频 → 填标题/正文/话题 →
封面/原创声明/定时 → 发布。

> ⚠️ 小红书未登录态是 **SPA 客户端 401 重定向回 `/login`**（发生在 domcontentloaded 之后），
> 所以 `_cookie_valid` 必须给足时间等重定向落定、且只认"出现发布页编辑控件"才算登录态，
> 不能 goto 完立刻判 URL（否则会误判"已登录"）。这是本内核相对上游做的加固。

## 加新平台

1. 新建 `<platform>_uploader.py`，实现 `async login()/check()/post(payload)`，复用 `base.emit_*`；
2. 选择器进各自的 `*_selectors.py`（**别叫 `selectors.py`**，撞标准库会让 asyncio 崩）；
3. 在 `cli.py` 的 `PLATuploaders` 登记 `"平台": "模块名"`。

协议不变，前端零改动。
