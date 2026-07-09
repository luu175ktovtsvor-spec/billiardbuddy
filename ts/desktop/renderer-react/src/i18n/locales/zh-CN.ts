// zh-CN 文案包(三分法之「文字」):对标真机 WorkBuddy 中文写法 + 白标(去 Claude/Anthropic/WorkBuddy 字样)。
// 标 ✓真机 的串来自解包 WorkBuddy.app i18n-7y71UgRW.js 逆向确认;其余按 owner 真机截图规范。
// 占位命名法:模型相关只用能力档代称(自动),绝不硬编码真实模型名。
export const zhCN = {
  app: {
    name: '球房管家',
    version: 'v0.1',
    tagline: '你的本机 AI 助手',
  },
  sidebar: {
    newTask: '新建任务',
    assistant: '助理',
    projects: '项目',
    experts: '专家·技能·连接器',   // ✓真机 nav 写法
    automation: '自动化',
    more: '更多',
    moreHint: '资料库·灵感',        // ✓真机 更多 右侧 muted
    sectionTasks: '任务',
    sectionSpaces: '空间',
    spaceGuide: '项目新手指引',
    newChat: '新对话',
    sessions: '对话',
    empty: '还没有对话,点上面「新建任务」开个头。',
    settings: '设置',
    notifications: '通知',
    collapse: '收起侧栏',
    filter: '筛选',
    search: '搜索',
  },
  topbar: {
    search: '搜索',
    share: '分享',
    history: '历史记录',
    panel: '预览面板',
  },
  chat: {
    // ✓真机占位写法(owner 截图):今天帮你做些什么？ + @ 引用 + / 技能
    placeholder: '今天帮你做些什么？ @ 引用对话文件，/ 调用技能与指令',
    send: '发送',
    stop: '停止',
    thinking: '思考中…',
    working: '处理中…',
    running: '运行中…',
    connected: '已连接',
    connecting: '正在连接…',
    disconnected: '连接断开了,正在重连…',
    emptyHero: '今天帮你做些什么?',
    emptyHint: '让我读写文件、跑命令、上网查资料、生图,或者挂上「台球运营专家」聊经营。',
    retry: '重试',
    runFailed: '这次没跑成:',
    maxTurns: '连着跑了好几个回合,先停下来喘口气。想接着做的话,回一句让它继续。',
    toolRunning: '执行中…',
    toolDone: '已完成',
    toolFailed: '出错了',
    footer: '内容由 AI 生成，请核实重要信息',  // ✓真机页脚,一字不差
    consumed: '共消耗',
    attach: '添加附件',
    mic: '语音输入',
  },
  actions: {
    copy: '复制',
    copied: '已复制',
    like: '赞',
    dislike: '踩',
    speak: '朗读',
    share: '分享',
    more: '更多',
  },
  model: {
    auto: '自动',   // 白标代称:模型选择器只显示「自动」,不露底层模型名
  },
  permission: {
    // ✓真机权限档:默认权限 / 规划模式 / 完全访问权限(自动接受编辑 为 acceptEdits 常规写法)
    default: '默认权限',
    acceptEdits: '自动接受编辑',
    plan: '规划模式',
    bypass: '完全访问权限',
    defaultDesc: '每一步对外/改动都先问你',
    acceptEditsDesc: '自动接受文件改动,其余仍会问',
    planDesc: '只做规划、先不动手',
    bypassDesc: '放开权限,少打断(谨慎)',
    title: '权限',
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
