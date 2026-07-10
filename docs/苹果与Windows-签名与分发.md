# 苹果 / Windows · 签名与分发说明（桌面版）

> 📌 状态:✅现行 · 最后核对 2026-06-26

> **给谁看:** 产品负责人 + 接手的新 AI 会话。讲清「要不要签名、怎么发给老板、你在 Mac 上测和老板在 Windows 上用差在哪」。
> **核实日期:** 2026-06-19,已查证 Apple / Microsoft **官方源**(出处见文末),时间敏感项(价格/最新政策)以官方为准。

---

## 0. 一句话结论（先看这个）

1. **台球房老板绝大多数用 Windows 电脑**(国内中小商户桌面市场 Windows 占绝对主流,Mac 是少数)。→ **Windows 才是真正的分发目标。**
2. Windows 和 Mac **都不强制签名也能跑**,但都会弹"安全警告";**Windows 的警告好绕得多**(点「仍要运行」即可),Mac 较劝退(新系统还取消了"右键打开"的简单绕法)。
3. 所以本产品的务实策略:**Windows 可以先不签名上线**(下载页教一句「点'仍要运行'」),**Mac 签名只在要发给"用 Mac 的老板"时才需要**(给你自己测试用,你会绕过即可,不必签)。
4. ⚠️ **你在 Mac 上测,看到的不等于老板在 Windows 上看到的**——窗口边框、字体、首次打开提示都不一样(详见第 3 节)。功能一样,"卖相"有差。

---

## 1. 苹果 macOS 签名（出处:Apple 官方）

| 项 | 结论 |
|---|---|
| App Store 之外分发(放网盘/GitHub 给人下)要不要签 | **要** Developer ID 签名 + **公证(notarization)**,否则 Gatekeeper 拦截、普通用户双击进不去 |
| 苹果开发者账号 | **99 美元/年**(约 ¥688);个人和公司同价,公司多需邓白氏(D-U-N-S)编码 |
| 不签的用户体验(最新 macOS Sequoia 15) | ⚠️ **"右键→打开"这个老绕法被取消了**。现在要去 **系统设置 → 隐私与安全性 → 往下点「仍要打开」**,输密码,再确认一次。只首次需要,但对非技术用户偏劝退 |
| 警告原理 | 浏览器下载的文件被打 `com.apple.quarantine` 隔离标记,Gatekeeper 靠它拦;`xattr -dr com.apple.quarantine /路径/xxx.app` 可删标记绕过 |
| 正面例子 | VS Code(微软)是**已签名+公证**的,所以双击就开 |

**结论:Mac 上唯一能让用户双击直接打开、零警告的正路 = 花 $99 签名 + 公证,没有更便宜的合规替代。**

---

## 2. Windows 签名（出处:Microsoft Learn · SmartScreen)

| 项 | 结论 |
|---|---|
| 要不要签 | **不强制**。不签会弹 SmartScreen「Windows 已保护你的电脑」,但**是警告、能绕**(「更多信息 → 仍要运行」),不是硬拦(除非企业组策略 / Win11 Smart App Control 开启) |
| 证书价位(2025,二手报价) | OV 约 **$200–300/年**、EV 约 **$300–500/年** |
| 2023 新规 | 所有代码签名证书(OV+EV)私钥**必须存硬件令牌 / 云 HSM**,不能再导出 .pfx 自己保管 → 更麻烦也是涨价主因 |
| ⚠️ EV 还值不值 | **EV 已经不能"秒过"SmartScreen 了**(微软 2024 取消该待遇)。现在 OV/EV 都得靠**下载量慢慢攒信誉**(通常几周/几百次干净安装)。→ **别为躲警告买贵的 EV,不值了** |
| 更便宜的新选项 | 微软 **Artifact Signing(原 Trusted Signing)约 $10/月**、不用硬件令牌、能接 GitHub Actions。能正规签名+显示发布者名,但**也不立刻消除 SmartScreen**(信誉仍按下载量攒) |

**结论:Windows 先免费裸发、下载页教「仍要运行」完全可行;量起来后用 Artifact Signing($10/月)正规签,别上 EV。**

---

## 3. ⚠️ 你在 Mac 上测 ≠ 老板在 Windows 上的体验

**功能/内容/绝大部分界面:一模一样**(同一套 Electron + Next.js 代码,跨平台)。AI 对话、知识、生成、改文件这些,两个系统上行为一致(模型 key 已全内置、开箱即用;BYOK 为可选进阶档)。

**但这几处不一样,Mac 上是"最佳版"、Windows 上略糙:**

| 差异点 | Mac(你测时) | Windows(老板用时) | 代码依据 |
|---|---|---|---|
| **窗口边框** | 无边框 + 原生红绿灯内嵌、顶部 52px 给它留位,干净 | 走**系统默认标题栏**(右上角 最小化/最大化/关闭),但前端那 **52px"红绿灯位"照样留着、却是空的** → "系统标题栏 + 一条空条",卖相糙 | `ts/desktop/electron/main.ts:151`(`titleBarStyle:hiddenInset` 仅 mac);`ts/desktop/renderer-react/src/components/layout/AppShell.tsx`(红绿灯位无系统区分) |
| **字体** | 苹果 SF 字体(设计就照它来的),最精致 | 没 SF,退回 微软雅黑 / Segoe UI,观感差一点 | 设计语言用 SF;Win 无此字体自动回退 |
| **首次打开提示** | Gatekeeper「无法验证开发者」→ 系统设置点「仍要打开」 | SmartScreen「Windows 已保护你的电脑」→「更多信息 → 仍要运行」 | 见第 1、2 节 |
| **毛玻璃 vibrancy** | 暂关(用 CSS 近似),两边一致 | 同左 | `ts/desktop/electron/main.ts` |
| **安装包** | .dmg(拖进应用程序) | .exe(nsis 安装向导) | `ts/electron-builder.yml` build.mac/win |

**所以:想知道老板真实看到啥,最好在一台 Windows 上实测一次** —— 光在 Mac 上看不到上面这些 Windows 侧的糙边。

**待打磨项(给 Windows 多数用户):** Windows 上那条空的 52px 红绿灯位 + 原生标题栏并存,卖相不如 Mac。后续可做"Windows 专属处理"(要么 Windows 也走无边框 + 自绘 Windows 风格窗口按钮,要么 Windows 上不留那 52px 条)。**这是已知的、可改的小工程,不是 bug。**

---

## 4. 给本产品的分发建议（Windows 优先）

1. **先上 Windows、先不签名**:出 nsis 安装包,下载页/安装说明里写明「首次打开点'更多信息 → 仍要运行'」。老板照做即可,零成本。
2. **Mac 端**:你自己测试用——本机用 `xattr -dr com.apple.quarantine` 或系统设置放行即可,**不必为自测花钱签名**。只有当要把成品发给"用 Mac 的老板"时,才花 $99 签名+公证。
3. **量起来后**:Windows 上 Artifact Signing($10/月)正规签,自然攒信誉脱敏;Mac 若有正式 Mac 分发需求再上 $99。
4. **优先级**:Windows 卖相打磨(第 3 节那条空条)> 签名。因为老板装上就会"看到",而签名警告"点一下就过"。

---

## 5. 当前状态 + 待办

- **当前打包配置 `desktop/package.json`:`"identity": null`、`hardenedRuntime:false` = 未签名**。Mac/Win 现在都会弹安全警告。
- **图标**:已修成 macOS 圆角(见 `desktop/scripts/make_rounded_icon.mjs`,执行 `cd desktop && npm run icon:rounded`),Mac/Win 都用;但要等**重新打包重装**才看得到圆角(已安装的旧包仍是方的)。
- **真要签名时,接进 electron-builder 的位置(我能帮你弄,等你拿到证书):**
  - **Mac**(在 `package.json` 的 `"mac"` 段):`hardenedRuntime:true`、`identity:"Developer ID Application: 你的名字 (TEAMID)"`、`notarize:{ teamId:"你的TEAMID" }`;打包时给环境变量 `CSC_LINK`(证书 .p12 路径)/`CSC_KEY_PASSWORD`、`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`(公证用)。*(确切字段以打包时 electron-builder 25 官方文档为准。)*
  - **Win**(`"win"` 段):2023 后私钥在硬件令牌/云 HSM,不能简单指 .pfx,得走自定义签名钩子或 Azure Trusted Signing 集成;比 Mac 麻烦,建议直接用 Artifact Signing 的官方 Action。
  - 注册账号/付款/拿证书这步**得你本人做**(要身份认证);拿到后把上面这些填进去 + 配好密钥环境变量,我来接。

---

## 6. 出处（可信度标注）

- **官方** · Apple:App Store 外分发需签名+公证 https://support.apple.com/en-us/102445 · Developer ID https://developer.apple.com/support/developer-id · 账号费用 https://developer.apple.com/programs/whats-included/
- **官方** · Microsoft:SmartScreen 与签名/信誉(2026-05 更新,含"EV 不再绕过 SmartScreen") https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- **二手(可靠)** · Sequoia 取消右键打开:https://mjtsai.com/blog/2024/07/05/sequoia-removes-gatekeeper-contextual-menu-override/ · 证书价格/CA-B 硬件令牌新规:https://www.ssl.com/products/software-integrity/code-signing/ · VS Code 已公证:https://www.theregister.com/2020/03/10/visual_studio_code_apple_notarisation/
- **二手** · quarantine 机制:https://eclecticlight.co/2021/12/11/explainer-quarantine/

> 价格与最新政策会变,重大决策前(尤其要花钱买证书时)建议再核一次官方页。
