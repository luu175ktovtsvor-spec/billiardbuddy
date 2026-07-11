// 预览种子(仅 ?preview=1 时启用):跳过后端连接,注入一组示例消息/会话,
// 让 Playwright/设计走查能在无 sidecar 时看到完整应用外观(左栏任务列表、主区消息+操作条、输入框、页脚)。
// 生产路径永不触发(URL 无 preview 参数即完全不加载)。
import { useChatStore, type ChatBlock } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTabStore } from '../stores/tabStore'
import { useFilePreviewStore } from '../stores/filePreviewStore'

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
    { id: 'p-u2', kind: 'user', text: '顺便给我一段算上座率的示例代码。' },
    { id: 'p-a2', kind: 'assistant', text: '好的,一段 TypeScript 示例:\n\n```ts\n// 上座率 = 在用台 / 总台数\nfunction occupancy(tables: number, active: number): number {\n  return Math.round((active / tables) * 100) // 百分比\n}\nconst rate = occupancy(20, 16) // 80\n```\n', streaming: false, ts: now - 2 * 60_000, tokens: 90 },
    { id: 'p-u3', kind: 'user', text: '把 README.md 和 BILLIARDBUDDY.md 各改一行。' },
    { id: 'p-e1', kind: 'tool', tool: 'edit_file', status: 'ok', input: { file_path: '/Users/swl/Desktop/球房运营AI助手-桌面版/README.md', old_string: '第一行\n第二行\n第三行', new_string: '第一行\n第二行改了\n第三行\n新增第四行' } },
    { id: 'p-e2', kind: 'tool', tool: 'edit_file', status: 'ok', input: { file_path: '/Users/swl/Desktop/球房运营AI助手-桌面版/BILLIARDBUDDY.md', old_string: 'a\nb', new_string: 'a\nb 改了\nc' } },
    { id: 'p-a3', kind: 'assistant', text: '两个文件都改好了,右侧可以点开审阅。', streaming: false, ts: now - 60_000, tokens: 40 },
    { id: 'p-u4', kind: 'user', text: '看看当前分支状态。' },
    { id: 'p-th', kind: 'thinking', text: '用户想看 git 状态。我先运行 git status 看当前分支和改动,再用大白话总结给他。', active: false },
    { id: 'p-cmd', kind: 'tool', tool: 'run_command', status: 'ok', input: { command: 'git status --short --branch' }, output: '## main...origin/main\n M ts/desktop/renderer-react/src/App.tsx\n?? new-file.ts' },
    { id: 'p-a4', kind: 'assistant', text: '当前在 **main** 分支,有 1 个改动 + 1 个未跟踪文件。', streaming: false, ts: now - 30_000, tokens: 30 },
  ]

  useChatStore.setState({
    conversationId: convId,
    blocks,
    status: 'idle',
    connected: true,
    runVerb: 'working',
  })

  // 右侧工作区面板种子(四栏:文件展示 + 工作树)——预览无后端,直接灌真实感数据
  const demoRoot = '/Users/swl/Desktop/球房运营AI助手-桌面版'
  useFilePreviewStore.setState({
    panelOpen: true,
    root: demoRoot,
    treeLoading: false,
    treeError: null,
    git: { isGit: true, branch: 'main', dirty: true, changed: 12, staged: 3, unstaged: 9, untracked: 2, ahead: 1, behind: 0 },
    tree: [
      { name: 'ts', path: 'ts', type: 'directory', children: [
        { name: 'src', path: 'ts/src', type: 'directory', children: [
          { name: 'server', path: 'ts/src/server', type: 'directory' },
          { name: 'harness', path: 'ts/src/harness', type: 'directory' },
          { name: 'index.ts', path: 'ts/src/index.ts', type: 'file' },
        ] },
        { name: 'desktop', path: 'ts/desktop', type: 'directory' },
        { name: 'package.json', path: 'ts/package.json', type: 'file' },
      ] },
      { name: 'docs', path: 'docs', type: 'directory' },
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'BILLIARDBUDDY.md', path: 'BILLIARDBUDDY.md', type: 'file' },
    ],
    tabs: [{
      path: `${demoRoot}/ts/package.json`,
      loading: false,
      error: null,
      content: '{\n  "name": "billiardbuddy-ts-harness",\n  "type": "module",\n  "scripts": {\n    "typecheck": "tsc --noEmit",\n    "ui:dev": "vite desktop/renderer-react",\n    "ui:typecheck": "tsc -p desktop/renderer-react/tsconfig.json"\n  }\n}\n',
    }],
    activePath: `${demoRoot}/ts/package.json`,
  })

  // 便于 e2e 需要时直接驱动
  ;(window as unknown as Record<string, unknown>).__qfStores = { useChatStore, useSessionStore, useTabStore, useFilePreviewStore }
}
