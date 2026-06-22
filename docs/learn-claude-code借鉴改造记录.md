# 借鉴 learn-claude-code 的 Harness 改造记录（2026-06）

> 来源：通读 GitHub `shareAI-lab/learn-claude-code`（6.75 万星·逆向+教学·20 章机制）。
> 方法：**先用只读审计把"产品已做到 vs 真缺口"分清，再精准补缺**——不照搬清单、不盲改。
> 结论：**本产品 harness 已相当成熟**，CC 那 20 章的硬机制大半早实现了（见下"已确认做对"）；只补了 4 处真缺口。

## 审计先验证：这些 CC 机制【产品早已做到】，无需改
- **知识渐进式披露（s07）**：系统提示零知识正文，只放工具描述 + 场景/知识目录（`find_scenario`/`look_up_knowledge`）；
  57 knowledge + 72 operation 正文走 bge-zh RAG 在生成工具内部按需召回，**只进生成调用、不回灌编排脑** → 比 CC 的 `load_skill` 更省 token。
- **压缩落盘顺序（s08）**：大结果先落盘再换占位符（`_cap_tool_result` 在 `_microcompact` 之前）；read 工具豁免落盘防"读→落盘→再读"死循环。
- **截断续写（s11）**：`finish_reason=="length"` → 续写 ≤3 次拼完整。
- **三级压缩全套**：snip → microcompact → autocompact，且 system 段受保护不动。
- **两级架构**：编排脑只看工具描述，执行层各工具内部 RAG 取知识。

## 本轮补的 4 处真缺口（全 Python 可验证、已测、已提交）

| # | 改动（对照 CC 章节） | 关键文件 | commit |
|---|---|---|---|
| 1 | **系统提示静态段前置**（s10）：`_today_line`(每天变)原卡在静态 HINT 中间，每天让后面静态内容 cache miss；重排为"静态前缀在前、动态尾段(日期→画像→店脑)在后"。注：DeepSeek/硅基流动是**服务端自动前缀缓存**，让前缀字节稳定即可，不用 Anthropic 式 `cache_control` | `api/v1/agent.py` `compose_agent_system_prompt` | `a39dae1` |
| 2 | **autocompact 连续失败熔断**（s08）：顶满窗口后若摘要 LLM 反复失败（BYOK 额度耗尽/模型报错），原每轮空烧；加 `autocompact_fail_streak`，真失败 +1、成功清零、≥3 熔断跳过。区分"真失败"与"不值得压" | `services/agent/{context,loop}.py` | `668323d` |
| 3 | **失败自动切 BYOK 供应商档**（s11·最值钱）：产品本有 CC-Switch 多档快切底座，失败只能手动切；`FailoverTextProvider` 装饰器在 agent.py 包住 provider，429/5xx/超时自动切下一套有 key 的档重试本次调用 | `services/ai/failover.py`、`api/v1/agent.py`(两处 provider) | `e6817bb` |
| 4 | **进程内每日定时**（s14）：opt-in（配 `DESKTOP_DAILY_DRAFTS_HOUR` 才启）到点自动备今日草稿、缓存，老板打开秒出；端点缓存优先。守红线：只产草稿、绝不自动发 | `services/daily_scheduler.py`、`api/v1/agent.py`、`main.py` lifespan | `9336312` |

**Task 3 设计要点（最高风险，刻意保守）**：loop.py 一行不动（provider 装饰器）；只在本次运行内切、**不在流式期写主库**（`set_active` 走独立 `profiles.db` 同步 sqlite）；流式仅"未吐 token 前"才切；防抖（一次最多切 2 套、试过不回头）；仅 BYOK + ≥2 套有 key 才包（否则零行为变化）。

**新增可选配置（默认关，零行为变化）**：
- `DESKTOP_DAILY_DRAFTS_HOUR=8` → 开启每早 8 点自动备今日草稿（opt-in = 同意每早花自己 BYOK token）。
- `DESKTOP_DRAFTS_DIR` → 草稿缓存目录（默认 `~/.billiards-desktop/drafts`）。

## Task 5：发布/剪辑后台异步 + 完成通知（s13）——【已决定放进真机验收一起做】

**为什么不在纯代码环境做**：① 是 Electron 主进程 + 前端 JS，纯命令行环境跑不起来 Electron，只能 `node --check` 查语法、没法真验证运行；② 读 `publish.js` 确认：**重活(patchright RPA / ffmpeg)本来就跑在独立子进程、不卡界面**，老板现在就能边发边在别处聊天——所以这是**体验 refinement**（点了立刻返回 + 跑完主动播报），不是会卡死的硬伤。按"改完≠验证通过"，不盲发不能验证的代码。

**真机时的实现计划（对照 CC s13）**：
1. `desktop/src/publish.js` `post()` / `video.js` `run()`：改为**立即返回 `taskId`**，子进程句柄进现有 `_running` Map 后台跟踪（已有句柄基础，欠"立即返回 + 完成事件"两步）。
2. `desktop/src/main.js`：IPC 由 `await 整个完成` 改为返回 taskId；子进程 `close` 时经**独立 channel**（如 `task:done`）`webContents.send({taskId, result})`。
3. `desktop/src/preload.js`：白名单暴露 `onTaskDone` 监听。
4. 前端：对话侧用一条**独立的 task_notification**（**不复用原 tool_use_id**，对照 CC s13 铁律）展示"✅ 发布完成/剪辑完成"，让老板提交后能继续聊、跑完 AI 主动播报一声。
5. 验证：真机 `npm run dev` 起壳，实际发一条 / 剪一段，确认立即返回 + 后台跑 + 完成通知；对照设计稿检查通知卡样式。

> 同期真机验收还需：打包出安装包 + 端到端验收（见 `交接-给新会话/现状与待办.md`）。
