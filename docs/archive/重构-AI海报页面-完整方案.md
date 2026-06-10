# 重构：AI 海报页面完整方案

> 目标：三段式布局 + 每个对话独立状态 + 修复已知 bug
> 执行前先 `git status` 确认当前状态。

---

## 一、页面布局

```
┌─────────────────────────────────────────────────────┐
│  顶部：输入区                                         │
│  ┌─────────────────────────────────────────────┐    │
│  │ [textarea: 描述你想生成的图片]                 │    │
│  │ [上传参考图] [比例 ▼] [质量 ▼] [生成]          │    │
│  │ [高级选项：融入门店信息 / 禁止文字]            │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
├────────────────────────────┬────────────────────────┤
│                            │  海报对话列表            │
│  中间：海报展示区           │  ┌──────────────────┐  │
│                            │  │ + 新对话          │  │
│  用户: 周末充值海报         │  │ 对话A: 充值活动.. │  │
│  [图片]                    │  │ 对话B: 赛事海报.. │  │
│  [基于此调整][重新生成][下载]│  │ 对话C: 开业活动.. │  │
│                            │  └──────────────────┘  │
│  用户: 背景改成深色         │                        │
│  [图片]                    │                        │
│  [基于此调整][重新生成][下载]│                        │
│                            │                        │
├────────────────────────────┴────────────────────────┤
│  底部：调整输入区（有海报后才显示）                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ [textarea: 描述调整内容]                 [➤] │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

## 二、数据结构：每个对话独立状态

```typescript
interface ConversationState {
  id: string | null;                    // conversation_id
  messages: ConversationMessage[];      // 对话消息列表
  refineFrom: string | null;            // 基于哪张图调整
  ratio: string;                        // 图片比例
  quality: "low" | "medium" | "high" | "auto";  // 质量
  references: Array<{ file: File; path: string; preview: string }>;  // 参考图
  addStoreInfo: boolean;
  noText: boolean;
}
```

**全局状态**：
```typescript
const [conversationsMap, setConversationsMap] = useState<Map<string, ConversationState>>(new Map());
const [currentId, setCurrentId] = useState<string>("new");
```

**当前对话快捷访问**：
```typescript
const current = conversationsMap.get(currentId) || createNewConversation();
const updateCurrent = (patch: Partial<ConversationState>) => {
  setConversationsMap(prev => {
    const next = new Map(prev);
    next.set(currentId, { ...current, ...patch });
    return next;
  });
};
```

---

## 三、核心操作

### 3.1 开新对话

```typescript
const handleNewConversation = () => {
  // abort 正在进行的请求
  if (abortControllerRef.current) {
    abortControllerRef.current.abort();
  }
  // 创建新对话
  const newId = `new_${Date.now()}`;
  setConversationsMap(prev => {
    const next = new Map(prev);
    next.set(newId, createNewConversation());
    return next;
  });
  setCurrentId(newId);
  setGenerating(false);
};
```

### 3.2 切换到历史对话

```typescript
const handleSwitchConversation = async (conv: ConversationItem) => {
  // 加载对话详情
  const detail = await api.getPosterConversationDetail(conv.id);

  // 从最后一条记录恢复参数
  const lastMsg = detail.messages[detail.messages.length - 1];

  // 重建消息列表
  const messages: ConversationMessage[] = [];
  for (const msg of detail.messages) {
    if (msg.prompt) {
      messages.push({ role: "user", content: msg.prompt });
    }
    messages.push({
      role: "assistant",
      content: "",
      images: [{ generation_id: msg.generation_id, poster_url: msg.poster_url, created_at: msg.created_at }],
    });
  }

  // 设置为当前对话
  const newId = conv.id;
  setConversationsMap(prev => {
    const next = new Map(prev);
    next.set(newId, {
      id: conv.id,
      messages,
      refineFrom: lastMsg?.generation_id || null,
      ratio: "3:4",      // 默认值，无法从历史恢复
      quality: "auto",    // 默认值，无法从历史恢复
      references: [],
      addStoreInfo: false,
      noText: false,
    });
    return next;
  });
  setCurrentId(newId);
};
```

### 3.3 生成

```typescript
const handleGenerate = async () => {
  const text = prompt.trim();
  if (!text || generating) return;

  // abort 旧请求
  if (abortControllerRef.current) {
    abortControllerRef.current.abort();
  }
  const controller = new AbortController();
  abortControllerRef.current = controller;

  // 更新当前对话
  updateCurrent({ messages: [...current.messages, { role: "user", content: text }] });
  setPrompt("");
  setGenerating(true);

  try {
    const res = await api.generateImage({
      prompt: text,
      image_model: "gpt-image-2",
      ratio: current.ratio,
      quality: current.quality,
      images: current.references.length > 0 ? current.references.map(r => r.path) : undefined,
      count: 1,
      refine_from: current.refineFrom || undefined,
      add_store_info: current.addStoreInfo,
      no_text: current.noText,
      conversation_id: current.id || undefined,
    }, controller.signal);

    // 更新对话状态
    updateCurrent({
      id: res.conversation_id || current.id,
      messages: [...current.messages, { role: "user", content: text }, { role: "assistant", content: "", images: res.images }],
      refineFrom: res.images?.[0]?.generation_id || current.refineFrom,
      references: [],  // 清空参考图
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    setError(getErrorMessage(err));
  } finally {
    setGenerating(false);
  }
};
```

---

## 四、需要修改的文件

### 4.1 前端：`web/src/app/dashboard/posters/page.tsx`

**整体重写**，核心改动：
- 删除 entry/conversation 双视图，改为单页面三段式
- 删除场景卡片
- 增加 `ConversationState` 接口和 `conversationsMap` 状态管理
- 每个操作（生成、切换对话、新对话）都操作 `conversationsMap`
- 海报对话列表移到右侧（桌面端）或底部（移动端）

### 4.2 后端：`server/services/poster_service.py`

**修复 1：参考图路径 bug**（第 137-144 行）
```python
# 当前（有 bug）
allowed_dir = Path(settings.upload_dir).resolve() / "references"
for ref_str in reference_image_paths:
    ref_path = Path(ref_str).resolve()
    if not str(ref_path).startswith(str(allowed_dir)):
        raise ValueError("...")

# 修复后
upload_dir = Path(settings.upload_dir)
for ref_str in reference_image_paths:
    rel = ref_str.removeprefix("/uploads/")
    ref_path = upload_dir / rel
    if not ref_path.resolve().is_relative_to(upload_dir.resolve()):
        raise ValueError("reference_image_path 必须在 uploads/ 目录内")
    if ref_path.exists():
        input_images.append(ref_path.read_bytes())
```

**修复 2：quality 默认值**（第 71 行）
```python
# 当前
quality: str = "standard",

# 修复后
quality: str = "auto",
```

### 4.3 删除：`server/api/v1/calendar.py`

用户要求删除内容日历功能。

### 4.4 修改：`server/api/v1/router.py`

删除 calendar 的 import 和 include_router。

---

## 五、参数传递链路（确保不串）

```
前端 ConversationState
  │
  │  ratio, quality, images, refine_from, conversation_id, add_store_info, no_text
  │
  ▼
POST /api/v1/posters/generate
  │
  ▼
Schema: ImageGenerateRequest
  │  quality 默认 "auto"
  │
  ▼
路由层: posters.py
  │  ref_paths = request.images or request.reference_image_paths
  │  透传所有参数
  │
  ▼
Service: poster_service.py
  │  quality 默认 "auto"（修复后）
  │  ratio → _get_api_size() → size
  │  refine_from → 查 DB 加载原图 bytes
  │  reference_image_paths → 加载参考图 bytes（修复路径 bug）
  │  conversation_id → 查 DB 拼接历史 prompt
  │  add_store_info → 追加门店信息
  │  no_text → 追加 "no text"
  │
  ▼
Provider: openai_image.py
  │  size.replace("*", "x")
  │  quality 直接传
  │  image 传 bytes
  │
  ▼
OpenAI API: images.generate / images.edit
  │  model="gpt-image-2"
  │  size="1024x1536"
  │  quality="high"
  │  image=[bytes]
  │
  ▼
返回 base64 → 保存 JPEG → 存 DB → 返回 URL
```

**每个环节的参数名和默认值**：

| 参数 | 前端 | Schema | Service | Provider | OpenAI API |
|------|------|--------|---------|----------|------------|
| ratio | "3:4" | "3:4" | "3:4" → size | size | size |
| quality | "auto" | "auto" | "auto" | "auto" | quality |
| images | [路径] | [路径] | [bytes] | image | image |
| refine_from | uuid | uuid | 查DB加载原图 | — | — |
| conversation_id | uuid | uuid | 查DB拼接历史 | — | — |

---

## 六、验证清单

- [ ] 页面三段式布局：顶部输入 → 中间海报 + 侧边对话列表 → 底部调整
- [ ] 场景卡片已删除
- [ ] 上传参考图后生成成功（路径 bug 已修复）
- [ ] quality 默认值为 "auto"
- [ ] 开新对话时 abort 旧请求
- [ ] 每个对话的 ratio/quality 独立，互不干扰
- [ ] 切换对话时恢复对应参数
- [ ] 海报对话列表正常显示
- [ ] "基于此调整"按钮正常工作
- [ ] "重新生成"按钮清空 refineFrom
- [ ] 底部输入框有海报后才显示
- [ ] `pnpm build` 通过
