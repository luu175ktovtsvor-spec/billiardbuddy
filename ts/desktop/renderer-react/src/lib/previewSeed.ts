// 预览种子(仅 ?preview=1 时启用):跳过后端连接,注入一组示例消息/会话,
// 让 Playwright/设计走查能在无 sidecar 时看到完整应用外观(左栏任务列表、主区消息+操作条、输入框、页脚)。
// 生产路径永不触发(URL 无 preview 参数即完全不加载)。
import { useChatStore, type ChatBlock } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore } from '../stores/tabStore'

export function isPreviewMode(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('preview')
}

const DAY = 86_400_000

const ASSISTANT_MD = `**本月经营快照**

整体客流比上月**回升 8%**,主要来自周末晚间时段。下面挑三个重点说:

- **周末上座率**:周五、周六 19:00–23:00 平均到 **82%**,接近满台;周中同时段只有 **41%**,落差明显。
- **人均时长**:单台平均 **1.9 小时**,比上月多 12 分钟,追分氛围带动明显。
- **助教体验单**:本月核销 46 单,转正价消费 **31 单**,转化率约 **67%**。

**接下来可以先做的**

1. 周中晚间上「结伴半价」,把闲置台面盘活。
2. 把周末满台时段的等位客,顺势引导到会员储值。

需要我把这些拉成一张可以直接发群的图文简报吗?`

export function applyPreviewSeed(): void {
  if (!isPreviewMode()) return
  const now = Date.now()
  const convId = 'preview-conv-1'

  useSessionStore.setState({
    sessions: [
      { id: convId, title: '本月经营诊断', updatedAt: now - 10 * 60_000 },
      { id: 'preview-conv-2', title: '周末活动文案', updatedAt: now - 4 * DAY },
    ],
    loading: false,
  })

  useTabStore.getState().openSession(convId, '本月经营诊断')

  const blocks: ChatBlock[] = [
    { id: 'p-u1', kind: 'user', text: '帮我看看这个月台球厅的经营数据,做个简单诊断,重点说说周末上座率。' },
    { id: 'p-a1', kind: 'assistant', text: ASSISTANT_MD, streaming: false, ts: now - 3 * 60_000, tokens: 1240 },
  ]

  useChatStore.setState({
    conversationId: convId,
    blocks,
    status: 'idle',
    connected: true,
    runVerb: 'working',
  })

  // 便于 e2e 需要时直接驱动
  ;(window as unknown as Record<string, unknown>).__qfStores = { useChatStore, useSessionStore, useTabStore }
}
