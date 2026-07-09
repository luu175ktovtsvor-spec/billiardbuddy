// zh-CN 文案包(三分法之「文字」):WorkBuddy 中文写法 + 白标(去 Claude/Anthropic/Haha 字样)。
// cc 组件文案用 t('key'),抄组件时把 key 填到这里。占位命名法:模型相关只用能力档代称,绝不硬编码真实模型名。
export const zhCN = {
  app: {
    name: '球房管家',
    tagline: '你的本机 AI 助手',
  },
  sidebar: {
    newChat: '新对话',
    sessions: '对话',
    empty: '还没有对话,点上面「新对话」开个头。',
    settings: '设置',
  },
  chat: {
    placeholder: '说说要做什么,回车发送,Shift+回车换行',
    send: '发送',
    stop: '停止',
    thinking: '思考中…',
    working: '处理中…',
    running: '运行中…',
    connected: '已连接',
    connecting: '正在连接…',
    disconnected: '连接断开了,正在重连…',
    emptyHero: '有什么可以帮你的?',
    emptyHint: '让我读写文件、跑命令、上网查资料、生图,或者挂上「台球运营专家」聊经营。',
    retry: '重试',
    runFailed: '这次没跑成:',
    maxTurns: '连着跑了好几个回合,先停下来喘口气。想接着做的话,回一句让它继续。',
    toolRunning: '执行中…',
    toolDone: '已完成',
    toolFailed: '出错了',
  },
  approval: {
    title: '需要你确认:',
    allowOnce: '允许一次',
    allowSession: '本次对话都允许',
    reject: '拒绝',
    approved: '已批准,正在执行',
    approvedSession: '已允许(本次对话)',
    rejected: '已拒绝',
    reasonWhy: '原因:',
    reasonImpact: '影响:',
  },
  common: {
    loading: '加载中…',
    error: '出错了',
  },
} as const

export type LocaleShape = typeof zhCN
