# D · spec-board.html 视觉保真度审查(像不像 WorkBuddy)

> 只读审查,三方对照:①WorkBuddy 逆向档案(`docs/references/WorkBuddy逆向档案/` 01/03/09/17/18/19)+ 竞品拆解 02/03 ②owner 现有前端(`ts/desktop/renderer-react/src/theme/{globals.css,workbuddy-tokens.css}` + `components/layout/Sidebar.tsx` + `components/chat/Composer.tsx`) ③被审对象 `spec-board.html`(1260 行,已起本地服务器截图核实)。

---

## 总判定:**半像,且判定对象本身选错了**

一句话:**spec-board.html 不是在冒充 WorkBuddy 的产品截图,它是一份内部工程规格文档(catalog of 22 pattern demos + 来源标签 + 状态徽章 + mono 注释),长得像 Storybook/设计走查表,不是长得像 WorkBuddy 聊天窗口。** 拿它去问"像不像 WorkBuddy"本身就是拿错了标尺——这份文件从头到尾没有尝试还原 WorkBuddy 的三栏 app 外壳(侧栏+聊天+右侧预览合成一屏),它是把 22 个交互点位拆成卡片摆成目录,每张卡里塞一个**迷你**demo。

但即便按"文档页面本身的视觉语言"来评,它也确实比 WorkBuddy 更像"技术蓝图/评审表",而不是"消费级产品"——这一点恰好命中 owner 的疑虑,是真的,不是多虑。核心问题两条:
1. **色板走偏**:demo 把 WorkBuddy 品牌绿(`#00C885`)当成通用强调色到处刷(选中态/进度条/spinner/链接/圆点),而 WorkBuddy 真机 + 你项目已落地的 `workbuddy-tokens.css` 都明确"强调色只用中性黑白,绿色只留给吉祥物笑脸"——这是 WorkBuddy 高级感的第一条铁律,demo 反而违反了自己项目已经做对的规则。
2. **字体基调走偏**:demo 几乎所有标签/标题/导航/来源标签都套 mono 等宽字体,WorkBuddy 真机是 PingFang SC 系统字体为主、mono 严格只用于代码块/版本号。满屏 mono + 10px 小字号,是 spec-board 读起来像"评审文档"而不像"产品"的真正原因。

如果 owner 想验证"设计方向到底像不像 WorkBuddy",**这份文件给不出答案**——它天然回答不了这个问题,该拿真正的整屏 mockup(三栏合成、用已校准好的 `workbuddy-tokens.css`)去看,而不是这份目录页。

---

## 逐维度判定

| 维度 | 判定 | 证据 | 具体改法 |
|---|---|---|---|
| **配色** | 半像 | demo `--accent:#00C885`(浅)/`#2FD39E`(深)= WorkBuddy 吉祥物绿,数值抄对了,**但用途抄错**——刷在 `nav-mini-item.active`(截图里的薄荷绿选中条)、进度条、spinner border-top、shell-sash hover、badge 圆点、链接色上。WorkBuddy 真机 + 项目已落地的 `workbuddy-tokens.css` 明确"主按钮/选中/焦点全走中性黑白,绿色只留给 logo"(`--color-primary: var(--wb-ink-light)` = `rgba(0,0,0,.9)`,`--color-smiley-*` 才是唯一绿)。demo 的 `--bg-page:#F3F2EF/--bg-surface-2:#ECEAE4` 也不是 WorkBuddy 真值(WorkBuddy gray-l1/l3 实测 `#FAFAFA/#F2F2F2`),而是抄了竞品拆解 02 文档里"参照 Qoder 暖灰阶"的**草案示例值**,和项目自己已实装的 `workbuddy-tokens.css` numeric 对不上,等于两套没对齐的色板同时存在。 | ① 把 demo 的 `--accent` 从"通用强调色"降级为"只用在链接/勾选/焦点环"这几个点,选中态/进度条/spinner 一律换回中性 `--text-primary`/`--border-strong` 的黑白灰阶,不用绿色打底。② 把 `--bg-page/--bg-surface/--bg-surface-2/--border/--text-*` 直接复用 `workbuddy-tokens.css` 里已校准的 `--wb-gray-l1~l5`/`--wb-black-90/70/50` 数值,别用竞品拆解 02 文档里的草案示例值重新发明一套。 |
| **布局/外壳** | 不像(但这是文档而非产品,预期内) | A1 卡片只是一个 64px 高的三栏比例示意图(mock 数值 264/48·360·318/500 是对的,和逆向档案 03 号文档一致),демо 整页真实布局是"卡片网格目录"(`card-grid: repeat(auto-fill, minmax(300px,1fr))`),完全不是 WorkBuddy 的三栏可拖拽 Grid App 外壳。呼吸感/密度这件事没法在这种目录页上评判。 | 若要验证"像不像",另建一个**整屏合成 mockup**(左 232px Sidebar.tsx 实况 + 中间聊天流 + 右侧预览面板全部拼在一个 1200×800 窗口里),而不是继续在这份规格板里加码;规格板留着当工程 checklist 用即可,不必往"产品截图"方向整改。 |
| **字体** | 不像(owner 疑虑成立) | 截图可见卡片编码(A1/B2)、来源标签(WB/cc/走法B)、导航面包屑、demo-label、brand-sub 全部走 `var(--mono)`,页面基础字号只有 12px、多数说明文字 9.5-10.5px。对照 01-设计系统.md:WorkBuddy 字体栈是 `PingFang SC/-apple-system/...`,mono 严格限定给 `--wb-font-code-family`(代码块);字阶 Body 14px/22行高,比 demo 密度大得多。demo 现在的"满屏等宽小字"读起来是 Figma dev-mode 标注面板 / Linear changelog,不是 WorkBuddy 那种偏产品化、字号更松的调性。 | 把卡片标题、来源标签文案、导航链接、section 标题一律换回 `var(--sans)`(PingFang SC 系统栈);mono 只留给真正的代码/路径/像素值(如 `264/48`、`cubic-bezier(...)`这类数值本身可以留 mono,但外层文案别用)。基础字号从 12px 提到至少 13px body。 |
| **圆角/阴影/质感** | 半像 | `--radius-xs:4/sm:6/md:8.../full` 和 WorkBuddy 真值(xs2/sm4/md6/lg8/xl12/2xl16)大致对得上,只是错位一档(demo sm=6,WB sm=4);`shadow-sm/md` 双层柔和阴影和 WB popover 阴影(两层叠加、低透明度)方向一致。但 demo 给几乎所有可点元素(btn/pill/quicknav a)都加了 `hover{transform:translateY(-1px)}`——WorkBuddy 真机的 hover 位移是"局部克制使用"(如仅 tab/次级菜单出现),不是全局铺开,demo 现在有点"到处都会抬起来"的卡片交互感,偏 Dribbble 风格而非 WorkBuddy 的克制。 | 圆角档位对齐 WB 真值(xs2/sm4/md6/lg8);把 blanket 的 `translateY(-1px)` hover 收窄到真正需要"可点击反馈"的卡片/主按钮上,普通 mono 标签/pill 不需要位移,回到"hover 只变色/变底色"。 |
| **文案话术** | 基本不适用(仅作参考) | demo 里的示例文案(排班表.xlsx/店庆活动/台球运营专家)是台球业务场景的示例数据,不是框架级 chrome 文案,不构成与 WorkBuddy 文案风格的直接可比对象;卡片自身元信息(如"折叠头不变,右侧状态区原地替换")是工程注释体,不是产品文案。 | 若后续把这些 pattern 落地到真实产品里,产品文案要按竞品拆解 03 号文档的"外热内专业+发生什么/怎么办"公式重写,当前 demo 阶段不必改。 |
| **组件级** | 半像 | Composer(E1)三层结构只是示意(外壳18px圆角/topArea 24px高,WB真值是28px),真实 `Composer.tsx` 甚至比 demo 更简化(单层 rounded-2xl,没有独立 topArea/mainArea/inputOverlay 三层)——demo 至少画出了三层的意图,真实组件还没做到 demo 的程度。C 区审批卡(红色二次确认+勾选门控+浅红禁用态)、D 区右侧预览(ViewSelector、概览面板、钉住状态机)这几个 mini demo 严格按逆向档案 17/18 号文档的行为规则复刻(数值、状态机转移都对得上),这部分"行为保真度"是真做到位的,只是渲染在卡片里而非整屏 UI 上。E2 的"+"按钮 45°旋转 0.42s cubic-bezier(.25,.8,.3,1) 精确复刻了逆向档案的动效细节。 | 组件行为规格可以直接作为下一步整屏 mockup / 真实 React 组件实现的验收基准(数值已经核对过,不用重新查一遍文档);视觉上把这些 mini demo 挪进真实组件时记得用 workbuddy-tokens.css 而非 demo 自己这套色板。 |

---

## 给 lead 的可执行修改清单(按影响排序)

1. **【最高优先】停止把 WorkBuddy 绿当通用强调色使**:demo 的 `--accent` 现在刷在选中态/进度条/spinner/链接上,和真实 WorkBuddy(以及本项目已经做对的 `workbuddy-tokens.css`:`--color-primary`/`--color-brand` = 中性黑白 `--wb-ink-light/dark`,绿色仅 `--color-smiley-a/b`)相悖。改法:demo 里所有"选中/进行中/强调"场景一律换用 `--text-primary`/`--border-strong` 的黑白灰阶,绿色只保留在"复选框选中勾"、"链接色"这类极窄点缀位。
2. **【高优先】色板数值源头统一**:demo 的 `--bg-page/#F3F2EF` 等来自竞品拆解 02 文档的**草案示例**,和已经实装、且经过真机校准的 `workbuddy-tokens.css`(`--wb-gray-l1~l5`)是两套不同数值。改法:demo 直接 `@import` 或手抄 `workbuddy-tokens.css` 的浅/深色值,别自己再兑一套,不然以后两份文件谁改了另一份不同步都不知道。
3. **【高优先】去 mono 化**:卡片标题、来源标签(WB/cc/走法B)、快捷导航、section 标题当前全走等宽字体是这份文档"看起来像蓝图不像产品"的最大单一原因。改法:这些文案换回 `var(--sans)`(PingFang SC 优先),mono 严格收窄到"数值/路径/CSS 片段"这类真正的代码内容。
4. **【中优先】如果 owner 要看的是"像不像 WorkBuddy"这件事本身**:该拿一个**整屏合成 mockup**(不是这份 22 卡片文档)去验证——用现有 `Sidebar.tsx`(已经做对:PingFang SC、gray-3 #F2F2F2 侧栏底、中性 ink 强调色)+ `Composer.tsx` + 一个新画的右侧预览面板,拼成 1200×800 的完整窗口截图,这才是能回答"像不像"的对象。当前 `Sidebar.tsx`/`Composer.tsx` 的保真度其实已经好于 spec-board.html(它们直接用 `workbuddy-tokens.css`,没有另起色板)。
5. **【低优先】hover 位移收窄**:demo 给几乎所有 btn/pill/链接都加了 `translateY(-1px)`,WorkBuddy 真机的位移反馈是局部克制使用,不是全局铺开;改法:去掉 quicknav/mono 标签类元素的位移,只留给真正的主要可点卡片/按钮。

---

## 回答 owner 的核心疑虑

**这版设计反映了 WorkBuddy 效果吗?** 部分反映——文档里逐条抄录的**数值/动效/状态机**(三栏尺寸、composer 三层结构、"+"按钮旋转曲线、审批红色二次确认、钉住状态机)都对得上逆向档案的真实取证,这部分"知道 WorkBuddy 怎么做"的功课是扎实的。但这份文件本身的**呈现层**(满屏 mono、绿色到处刷、卡片网格目录感)没有反映 WorkBuddy 的产品视觉语言,反而更像一份工程评审文档——这不是失败,是文件的用途本来就不是"看起来像 WorkBuddy",而是"记录清楚要抄哪些数值"。

**最该修的是什么才能真正"像 WorkBuddy"?** 两件事:①把这份文档自己的色板换成项目已经校准好的 `workbuddy-tokens.css`(尤其去掉绿色乱刷、去掉重复发明的暖灰草案值);②认识到"像不像"这个问题不该问这份文档,该去拼一个真实整屏 mockup 来看——现有 `Sidebar.tsx`/`Composer.tsx` 已经比这份新 demo 更贴近 WorkBuddy 真值,直接拿它们合成一屏截图,比继续雕琢这份 spec-board 更能回答 owner 的疑虑。
