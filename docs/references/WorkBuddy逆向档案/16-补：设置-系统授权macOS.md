# 16-补：设置-系统授权（macOS）SystemPermissions / SystemAuthorization

> **第二轮穷尽补齐**（2026-07-10）。归属：**App 外壳 = WorkBuddy** 侧（macOS 专属设置屏 + 主进程权限检查）。
> **可信度**：无原始 tsx，靠反混淆可读源（esbuild 保留函数名/注释）推断，结构准确；纯 CSS 主题深浅色以 fallback 值为准。
> **结论先讲**：设计上 5 项（完全磁盘/辅助功能/自动化/通知/日历），**真正列出来只有 3 项**（完全磁盘、辅助功能、自动化）。通知搬去"通用设置→桌面通知"；日历数据里有但被 filter 掉且后端恒返回未授权；"还有 N 项未授权"是 i18n+CSS 有、当前构建**没渲染**的死代码。这页两种长相取决于"安全中心"开没开，二选一互斥。
> **务实取舍**：见第十节——我们只做独立页一种呈现即可。

---

## 一、页面入口与显隐规则
- 导航项：`{id:"systemPermissions", labelKey:"settings.nav.systemPermissions", localOnly:true, macOnly:true, icon:<Shield/>}`。仅 **macOS 本地桌面版**出现。
- 过滤逻辑（关键）：`if (item.id==="systemPermissions" && securityCenterEnabled) return false;`（安全中心开则隐藏系统授权，反之）。`isMacOS()` = `navigator.userAgentData.platform==="macOS"` 或 `/Mac|iPhone|iPad|iPod/.test(navigator.platform)`。
- **两种互斥呈现**（同数据、两组件）：①安全中心关 → 独立"系统授权"页 `SystemPermissionsPanel`（大标题 + 卡片列表 + 绿色实心"去授权"）；②安全中心开 → 降级为安全中心里一张卡 `SystemAuthorizationCard`（行式 + 描边胶囊按钮）。
- 只有停在 systemPermissions/securityCenter tab 时 `isActive=true` 才发起权限检查。
- **务实简化**：我们没有"安全中心"层，直接照抄 `SystemPermissionsPanel`（独立页）一种即可。

---

## 二、权限清单（数据模型 vs 实际渲染，坑在这）
数据模型 `PERMISSION_IDS = ["fullDiskAccess","accessibility","automation","calendarAccess"]`（**无 notification**；注释：通知授权已迁移到「系统设置→通知」）。`getPlatformPermissionIds()` 非 mac 返回空。
**实际渲染**：`SystemPermissionsPanel` `permissions` 数组**硬编码只有 3 项**（fullDiskAccess/accessibility/automation，无 calendar 无 notification）；`SystemAuthorizationCard` `getPlatformPermissionIds().filter(id!=="calendarAccess")` 同样 3 项。→ **两处都只显示 3 项。**

| id | 标题 | 描述 | 图标 | 系统设置深链 |
|---|---|---|---|---|
| fullDiskAccess | 完全磁盘访问权限 | 允许访问磁盘上的所有文件,部分功能需要此权限才能正常工作 | `HardDrive` | `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles` |
| accessibility | 辅助功能 | 允许响应键盘快捷键,便于快捷唤起等功能 | `Keyboard` | `...?Privacy_Accessibility` |
| automation | 自动化 | 允许能给其他 App 发指令,比如帮你管理日历、提醒事项、备忘录等 | `Workflow` | `...?Privacy_Automation` |
| calendarAccess (不显示) | 日历访问 | 允许读取和管理你的日历... | `CalendarDays` | `...?Privacy_Calendars` |
| notification (已移出) | 通知 | 允许发送桌面通知... | — | `x-apple.systempreferences:com.apple.preference.notifications` |

常量集中在 `constants.ts`：`PERMISSION_SYSTEM_URLS`/`PERMISSION_ICONS`/`NOTIFICATION_SETTINGS_URL`/`PERMISSIONS_WITHOUT_BADGE=new Set()`（空集→所有行都显示徽章）。

---

## 三、全部 i18n（已核实）
```
settings.nav.systemPermissions        = 系统授权
settings.systemPermissions.title      = 系统授权
settings.systemPermissions.subtitle   = {name} 在电脑上运行所需要的系统授权
settings.systemPermissions.helpTip    = 如需取消已有授权,请前往 macOS 系统设置中自行操作
settings.systemPermissions.authorized   = 已授权
settings.systemPermissions.unauthorized = 未授权
settings.systemPermissions.authorize    = 去授权
settings.systemPermissions.pendingCount = 还有 {{count}} 项权限未授权   ← ★i18n 有,但全代码库无 .js 引用(死文案)
```
`{name}` 用 `useAssistantDisplay` 取产品名（默认 WorkBuddy，白标换"球房管家"）。`pendingCount` 用双花括号 i18next 插值，其余单花括号，进一步佐证它没接线。

---

## 四、`SystemPermissionsPanel` DOM + 交互（推荐照抄）
```
div.system-permissions-panel
├─ h2.__title → 「系统授权」
├─ div.__subtitle
│    ├─ span → subtitle「球房管家 在电脑上运行所需要的系统授权」
│    └─ Tooltip(helpTip, bottom, maxWidth260) → span.__help-icon <HelpIcon/>(14×14 圆圈问号)
└─ div.__list (permissions.map)
     └─ div.__item
        ├─ __item-icon <PermissionTypeIcon/>(18×18 stroke2)
        ├─ __item-content
        │   ├─ __item-header: __item-title + __item-badge(--authorized绿/--unauthorized橙)
        │   └─ __item-desc
        └─ button.__item-action  ← 仅 unauthorized 时渲染
             dt-eid="settings_system_permission_authorize" → handleAuthorize(id) 「去授权」
```
**交互**：已授权→显示绿"已授权"徽章、**不渲染按钮**；未授权→橙"未授权"徽章 + 绿实心"去授权"。点"去授权"→ `onAuthorizeClicked(id)`（标记激活、写 localStorage）+ `adapter.emit("open-external", PERMISSION_SYSTEM_URLS[id])`。
**CSS 里有 `__footer`（"还有 N 项未授权"位置）但 JSX 没渲染** —— 若要计数自己补 footer，数据现成：`Object.values(permissionStatusMap).filter(s=>s==="unauthorized").length`。

## 五、`SystemAuthorizationCard`（安全中心里的卡，备选，可不做）
结构 `security-center-panel__system-auth-row`：标题+描述竖排在同一行右侧带按钮；徽章 `--safe`(绿)/`--notice`(黄橙)；按钮是**描边胶囊**（radius999 transparent 底）而非绿实心。

---

## 六、状态检查机制（懒检查，直接影响是否弹系统框）
`useSystemPermissions(isActive)`：
1. **懒检查**：`localStorage["system-permissions-activated-ids"]` 记住用户**点过"去授权"**的 id 集合。注释：仅对"已激活"权限发起检查，避免首装弹 osascript 窗。
2. `refresh()`：`if (idsToCheck.length===0) return;` → 否则 `adapter.emit("check-system-permissions",{permissionIds})`。
3. `onAuthorizeClicked(id)`：加进 activatedIds + 写 localStorage（只加不减，幂等）。
4. `useEffect`：`on("system-permissions-result", ...)` 收结果合并 map；挂载即 refresh 一次。
5. 监听 `window "focus"`：从系统设置授权完切回应用**自动 refresh**（macOS 授权后无回调，只能靠 focus 重查）——关键。
6. 返回 `{permissionStatusMap, refresh, onAuthorizeClicked}`。

---

## 七、主进程真实检查（`main/index.js`，决定每项怎么判定）
`checkSystemPermissions(ids)`：非 darwin 返回 `{}`；`status==="skip"` 不写结果。`checkOneSystemPermission` 分派：
- fullDiskAccess → **`checkFullDiskAccess`**：尝试 `fs.open(~/Library/Application Support/com.apple.TCC/TCC.db,"r")` 读 16 字节 → 成功=authorized，EPERM=unauthorized（用能否读 TCC.db 反推，纯读无副作用）。
- accessibility → `systemPreferences.isTrustedAccessibilityClient(false)`（false=不弹提示）。
- automation → **`execFile("osascript",["-e",'tell application "System Events" to get name of first process'],{timeout:3000})`** → 成功=authorized；stderr 含 `-1743|not allowed|not authorized`=unauthorized。**这条会真触发 macOS 自动化授权弹窗**（正是懒检查要避免首装即弹的原因）。
- notification → `"skip"`（不查不返回）。
- calendarAccess → `"unauthorized"`（硬编码永远未授权，没实现真检查）。
- **去授权跳转 darwin 兜底**（`openExternalUrl`）：macOS 上 `x-apple.systempreferences:` 深链先 `execFile("/usr/bin/open",[url])`，失败再退 `shell.openExternal`（Ventura/Sonoma 上 `shell.openExternal` 对这类 scheme 静默失败）。协议白名单 `{http,https,x-apple.systempreferences,ms-settings}`。**我们做去授权跳转必须照抄这个 open 兜底，否则点了没反应。**

---

## 八、通知授权 = 独立处理（在"通用设置"，不在系统授权页）
`GeneralSettingsPanel` 两条 SettingSection：桌面通知（desc"允许发送系统桌面通知,任务完成或有新消息时即时提醒。" action=绿"去授权"按钮+外链箭头，`handleAuthorizeNotification` = `requestNotificationRegistrationIfNeeded()` + `emit("open-external", NOTIFICATION_SETTINGS_URL)`，localStorage key `settings-notification-registration-requested`）+ 客户端通知（Switch）。→ 通知授权按 WorkBuddy 做法放"通知/通用设置"里当独立一行，不塞进系统授权列表。

---

## 九、CSS / 色值（`~1230040` 起，已提取实值）
`SystemPermissionsPanel`：`__title` 20/650 `#d2d3e0`；`__subtitle` 12/400 `#858699` 底 1px `#3c3c3c`；`__list` flex column gap8；`__item` flex gap12 padding10×14 radius4 底 settings-card；`__item-icon` 18×18；`__item-title` 13/650；`__item-badge--unauthorized` 橙 `#f97316` 底 `rgba(249,115,22,.15)`、`--authorized` 绿 `#4caf50` 底 `rgba(76,175,80,.15)`；`__item-desc` 12/400；`__item-action` min-width64 h30 radius4 底 `#4caf50` 白字（绿实心）；`__footer` 定义了但 JSX 没用。

---

## 十、务实取舍标注（必做 / 可简化 / 暂不做）

**必做（三个工程细节，照抄不坑）**：
- ①**懒检查**（只查用户点过去授权的项，避免首装弹 osascript 框）；
- ②`window focus` 回刷状态；
- ③去授权跳转的 `/usr/bin/open` 兜底（否则 Sonoma 上点了没反应）。
- 三项检查法可复用：完全磁盘=读 TCC.db；辅助功能=`isTrustedAccessibilityClient(false)`；自动化=osascript 探 System Events。

**可务实简化**：只做独立"系统授权"页（照抄 `SystemPermissionsPanel`），不做安全中心那套双呈现；列表放 3 项就够。"还有 N 项未授权"想要就自己补 footer（数据现成）。

**暂不做**：`SystemAuthorizationCard` 备选呈现；日历（后端空壳恒 unauthorized，要真做得自己实现真检查）。通知若要，仿其放"通知设置"单独一行。**若只发 Windows，整个系统授权页可不做**（macOnly）。

**关键文件（绝对路径）**：主进程 `wb-deep/main/index.js`（checkFullDiskAccess≈13277、checkAutomation≈13292、checkOneSystemPermission≈13304、checkSystemPermissions≈13314、checkAccessibility≈12384、openExternalUrl≈12847、registerSystemHandlers≈13444）；渲染层 `wb-deep/renderer/assets/connector-CvFT3fv6.js`（useSystemPermissions≈1102338、constants≈1544700、SystemAuthorizationCard≈2261200、SystemPermissionsPanel≈2323293）。

---

## 盲区
1. 只有混淆 bundle 无原始 tsx，结构靠反混淆源推断（准确），但纯 CSS 深浅具体色依赖运行时 cb-chat-ui 变量，给的是 fallback，真机需吸色确认。
2. "还有 N 项未授权"全库 grep 只在 i18n 两处，无渲染代码，CSS 留 `__footer` 空位——判为"设计保留、未接线"。
3. 通知"已授权"态展示细节（按钮 vs 徽章切换条件）没逐行读 GeneralSettingsPanel（读 `getNotificationSettings`/registration 状态），超出本页本体。
4. calendarAccess 为何两处都滤掉：代码事实清楚（硬滤+后端恒 unauthorized），是否别构建放开过日历无从判断。
5. 未真机运行验证（纯静态逆向）。
