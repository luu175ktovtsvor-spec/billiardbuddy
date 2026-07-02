# 老 web 能力融回桌面 · 清单(2026-06-27)

> 📌 状态:✅现行 · 最后核对 2026-07-02

> **怎么来的**:桌面端是单窗口**重新开发**,老 web(早期检出 `~/Desktop/球房 ai 运营助手`,保留了被砍的全部页面/服务)做过很多事。两个只读子代理系统盘点了"老 web 有、桌面丢了/够不到、值得融回"的。下面带证据(file:line),**真要做某条前先回验该证据再动手**(子代理结论需复核)。
> **框架**:老 web 大头能力已被桌面 agent 包成工具(诊断/海报/活动/约客/玩法/改写都在)。缺口只两类:① **装好了没接线**(原生/service 在,agent 没暴露/UI 丢了,老板够不到);② **整块删了**(能力真没了)。

## 🥇 优先级排序(值得融回的)

| # | 能力 | 桌面现状(证据) | 怎么搬 | 价值 |
|---|---|---|---|---|
| 1 | **一键发布**(抖音/快手/视频号/小红书) | 🟡 `desktop/src/publish.js` + `desktop/publisher/*.py` + `main.js` 的 `publish:*` ipc + `preload.js` 的 `electron.publish.*` **全在**;但 `web/src` 零引用、`publish/page.tsx` 删了、agent 无发布工具 | 做 agent 工具 `publish_to_platform`(`requires_approval`/`force_confirm`,对外动作)+ 扫码登录/确认浮层(复用 confirm-dialog + preview-panel 事件通道)。老板"把这视频发抖音,标题用刚那条"→弹扫码→人确认才发 | ⭐⭐⭐⭐⭐ |
| 2 | **视频剪辑**(本机 ffmpeg) | 🟡 `desktop/src/video.js`(转竖屏/裁剪/字幕/水印/变速 ffmpeg 命令全在)+ `video:*` ipc + `preload.electron.video.*` + `ffmpeg-static` **全在**;无工具/UI | 做工具 `edit_video`(op+参数);和发布是**一条流水线**(剪→发),一起搬 | ⭐⭐⭐⭐ |
| 3 | **日报 + 一键 Excel** | 🟡/❌ `report_service/report_excel/report_schema` + `report_forms/` 5 张表 **整块删了**(只剩 `report_reader` 读 POS 报表做诊断·方向相反)。**且桌面 dashboard 仍弹"今天日报没写→去写"假提醒,点过去是空的** | 做工具 `write_daily_report`(老板说几个数→算环比/本月累计/排名→AI 写三段→复用 `edit_excel` 导 Excel);老 report_service 纯函数可直接捞。**或先把假提醒摘掉** | ⭐⭐⭐⭐ |
| 4 | **✅ 效果好/收藏 反馈闭环(已落地 `f238927`)** | ✅ 已落地：`chat-thread.tsx` `RateGoodButton` 成品卡点👍写 `effect_rating`，闭环不再空转（原判"无处点👍/⭐"已过时） | ~~成品卡(preview-panel 已渲染)加轻量 👍/⭐ → 回写 `effect_rating`~~ | ⭐⭐⭐ |
| 5 | **前台/投诉 SOP** | 🟡 模板全在(`operation/frontdesk_sop.yaml`/`complaint_handling.yaml`/`opening_closing_sop.yaml`),但 `sop_service` 没搬、agent 无工具 | 做 `query_sop`(岗位+场景);老板"前台迎宾怎么说""客人投诉了怎么接"立刻有标准话术。轻量高频 | ⭐⭐⭐ |
| 6 | **绩效考核模板** | 🟡 `performance_template.yaml` 在 + `scenario_role_map` 登记,但 `performance_service` 没搬、无工具 | 做 `make_performance_template`(岗位+周期),或保证 `find_scenario` 稳命中它 | ⭐⭐⭐ |
| 7 | **好评差评回灌写作** | 🟡 `brand_voice_service`(点赞学风格/点踩进避免清单 → 喂写作 prompt)**没搬**;桌面 recall 只给老板看、不自动改写作 | 把 `get_brand_voice_context` 接进 `write_operation_content`/`write_batch` 的 prompt 拼装(和 #4 一条线) | ⭐⭐⭐ |
| 8 | **多岗位协同**(orchestrator) | 🟡 `orchestrator`(指挥官+多岗位并行+汇总对齐口径)整块没搬;桌面只有单个 `run_subagent` | 看定位:要接"策划完整开业季/大型赛事"才值得融成 `plan_big_activity`;单店轻量可暂缓 | ⭐⭐ |

## 📦 运营内容("少掉"的 5 个玩法模板)——⚠️ 大概率是有意清的,别当损失补回
> **owner 2026-06-27 纠正**:**老 web 知识库本身错乱、没完全对照 PPT;桌面端知识库是有意按 PPT-only 重新校准的修正版。** 所以下面这些"老 web 有、桌面没有"的模板,**很可能是桌面照 PPT-only 政策故意清掉的(PPT 没据/借鉴别处/错乱),不是丢了。** 子代理说的"知识库有据"**不可信、必须逐条对本地 PPT 底本(`~/Desktop/球房-PPT底本-本地存档/`,见 [[ppt-source-of-truth-location]])亲自核实**——真有据才考虑补,且**一律以桌面 PPT-aligned 版为准、绝不以老 web 为准**。下表的"是否补"列已作废,改成"先验 PPT"。

| 模板 | 玩法 | 桌面现状 | 验后再说(别直接补) |
|---|---|---|---|
| **corporate_team_building** 企业团建**获客** | 开发企业HR包场+团建后转长期客裂变 | 桌面 `team_building_plan` 是**内部排班·不同义**(别混) | **先验 PPT**:PPT 真有"企业团建获客"打法才补(只补方法别编报价);PPT 无据=桌面有意清的,不补 |
| **theme_night** 主题之夜 | 单身夜/闺蜜场/情侣场,氛围社交拉人不靠折扣 | 🟡 退化成泛 `plan_activity` | **补**(知识库有据·高频可复用) |
| **sports_event_watching** 看球活动 | 蹭世界杯/斯诺克世锦赛热点 | 🟡 退化成泛 `plan_activity` | **补**(知识库有据·蹭大赛现成获客) |
| **opening_event** 开业致辞脚本 | 致辞+主持稿+流程节点 | 🟡 有开业文案但无脚本 | 中(与现有部分重叠) |
| **ip_cooperation** 助教IP合作 | 助教打造个人IP | 🟡 退化 | 低(偏虚·可不补) |

> 虚惊(确认不是损失):`prompts/fewshots/`(生成管道零消费的孤儿,删得对)、knowledge 桌面反而多 5 个索引、activity/copywriting/recruitment 逐字一致无瘦身。

## 🔑 全局(不是搬·是默认开不开)
台球工具全被 `@台球知识库` 开关挡在默认外(`registry.py` BILLIARDS_TOOL_NAMES + `agent.py:262` billiards_registry vs general_registry,默认通用)。**⚠️ 这是 owner 的有意设计**([[general-agent-reframe]]:盒子=通用默认、台球=可挂载),不是 bug。但子代理点出:一个叫"球房运营助手"的产品默认是通用助手、核心台球能力要老板自己 @ 才出现,可能埋没卖点。**是否对这个产品默认开台球/首启即挂——owner 拍板。**

## 落地建议
前 2 个(发布/剪辑)是桌面版**存在意义的一半**、代码现成只差接线,性价比最高;#3 日报有个"假提醒挖坑没填"的体验窟窿最扎眼;#4 效果闭环投入极小却让核心卖点活过来。内容上企业团建获客最该补回。**逐条做前先回验证据。**
