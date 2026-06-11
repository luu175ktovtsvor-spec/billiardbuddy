# AI 生图（海报）架构重设计

> 日期：2026-06-12
> 状态：已实现
> 范围：`server/services/poster_service.py`、`web/src/app/dashboard/posters/[conversationId]/page.tsx`、`lib/api.ts`

---

## 一、用户体感模型（设计出发点）

球房用户生成海报时，手里有三类素材，且对它们的预期不同：

| 素材 | 用户预期 | 旧实现的断点 |
|---|---|---|
| **文字要求** | 每轮叠加生效（"周赛海报"→"背景改深色"） | ✅ 已有（历史 prompt 拼接） |
| **底图**（"基于此调整"选的那张） | 在这张图上改，构图别变 | ✅ 已有（refine_from → images.edit） |
| **参考图**（上传的风格图/门店照片） | "照这个感觉来"，**传了就一直算数** | ❌ 两个断点：①调整模式下被 `elif` 整个丢弃，模型根本没看到；②生成一轮后前端清空，下一轮不再发送 |

核心重设计决策：**参考图升级为"对话级资产"，底图与参考图不再互斥。**

## 二、新架构

### 图片角色模型（每轮请求）

```
images.edit 输入 = [底图（若在调整模式，永远第 1 张）] + [对话的全部参考图（≤15 张）]
prompt 中显式声明角色：
  "The first input image is the base image to modify;
   the remaining input images are style references only, do not copy their content"
```

不声明角色时模型分不清底图和参考图，会把参考图内容抄进结果——这是多图输入的关键正确性条件。

### 参考图记账：前端持有，每轮全量发送

- 前端 `ConversationState.references` 为对话级状态：上传即加入、生成后**不清空**、可随时 × 移除（移除即下一轮不再发送，控制权在用户）
- 加载历史对话时，从各轮 `input_params.reference_images` 去重恢复
- 之所以不让后端自动从历史收集：用户"中途不想再参考某张图"时将无法撤销，所见即所发更符合直觉

### 校验前置（先验证、后花钱）

`conversation_id` / `refine_from` 的 UUID 解析、底图的存在性+门店归属+类型校验，全部移到注入检查/配额检查之前。旧实现在生图 API 调用成功**之后**才爆非法 UUID——钱花了、全标失败、不计费。

### Prompt 组装提取为纯函数

`build_poster_prompt(prompt, history_prompts, has_base_image, ref_count, ...)`，四种图片组合（底图+参考/仅底图/仅参考/无图）各有对应角色声明，有回归测试锁定。

## 三、本次落地的改动

**后端 `poster_service.py`**
1. 修复 `elif` bug：底图与参考图合并传入（底图第 1 张，总数限 16）
2. 全部校验前置；refine_from 查询加 `store_id + type=poster + is_deleted` 过滤
3. `input_params` 记录 `refine_from`；对话详情接口返回 `reference_images` / `refine_from` / `ratio`（供前端恢复状态）
4. 路径穿越显式拒绝 `..`（resolve 校验保留）
5. prompt 组装提取为 `build_poster_prompt` 纯函数 + 2 条回归测试

**前端 `posters/[conversationId]/page.tsx`**
1. 参考图对话级持久：生成后不清空、加载历史时恢复、带"对本次对话持续生效"提示
2. 调整模式可视化：输入框上方显示底图缩略图 chip + 一键退出调整模式（旧版只有一行灰字）
3. 比例/质量从原生 `<select>` 改为 CardSelect（收进"比例与质量"折叠面板，折叠标题显示当前值）
4. 加载历史对话时恢复上一轮的比例（旧版强制重置 3:4，多轮中途比例漂移）

## 四、刻意不做的

- 不引入 Responses API / previous_response_id（组织验证不可用，现 workaround 已满足需求）
- 不做海报拖拽编辑器（CLAUDE.md 禁令）
- 9:16 与 3:4 共用 1024x1536 输出尺寸维持现状（标准 Image API 仅支持三档尺寸，改动需先抓官方文档验证）
- 不改按成功张数计费、注入检查、配额检查（P0/P1 轮已修好）

## 五、遗留

- 失败张数>0 时仅 log，前端不展示"N 张失败原因"——影响小，待用户反馈
- poster_limit 套餐字段仍未接入生图配额（生图目前与文本共用次数配额）
