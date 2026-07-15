// zh-CN 文案包(三分法之「文字」):对标 Codex 中文写法 + 白标(去 Claude/Anthropic/模型名字样)。
// 现以 Codex 真机 + owner 截图为文案权威;个别串早期从别处逆向起底,以 Codex 为准校准。
// 占位命名法:模型相关只用能力档代称(自动),绝不硬编码真实模型名。
export const zhCN = {
  app: {
    name: '球房管家',
    version: 'v0.1',
    tagline: '你的本机 AI 助手',
  },
  sidebar: {
    // 主导航按「两条线」重排(owner 2026-07-11):不照抄 WorkBuddy 的多助理协作 IA,每一项都接我们后端真实系统。
    // ── A 线(喂给模型循环的东西)──
    newTask: '新建任务',           // 开新会话 → chatStore
    scheduled: '已安排',            // Codex:定时/计划任务入口(占位)
    plugins: '插件',                // Codex:插件/扩展入口(占位)
    domainExpert: '领域知识',       // 挂/切领域知识包 packs → /api/v1/agent/packs
    domainExpertHint: '通用 / 台球',
    skillsConnectors: '技能 · 连接器', // 斜杠技能 + MCP 连接器 → /api/v1/agent/skills + /api/v1/agent/mcp
    // ── B 线(确定性产品工作台)──
    workbench: '创作工作台',        // 生图 + 视频剪辑 → /api/v1/studio + /api/v1/video-edit
    automation: '自动化',           // 定时任务 → /api/v1/scheduled-tasks
    sectionTasks: '任务',
    sectionProjects: '项目',        // Codex 左栏「项目」分组
    sectionConversations: '任务',   // 对齐 Codex 中文:thread=「任务」,与顶部「新建任务」统一

    archived: '已归档',
    sectionWorkspace: '工作区',
    workspaceDefault: '默认工作区',
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
  // 分享弹窗(复制整段对话文字;全本地软件没有在线分享链接)
  share: {
    title: '分享对话',
    hint: '把这段对话复制成文字',
    copy: '复制对话',
    note: '复制后可以直接粘贴到微信、备忘录等任何地方;思考和操作过程不会带进去。',
  },
  // 已安排(定时任务列表 · 照 Codex/ChatGPT「Scheduled tasks」)
  scheduled: {
    title: '已安排',
    subtitle: '让管家按时自动跑一件事——每天盯一次数据、每周出一版文案,到点自动开一轮对话。',
    newTask: '新建定时任务',
    emptyTitle: '还没有定时任务',
    emptyHint: '点右上角「新建定时任务」,让管家按你定的时间自动开工。',
    comingSoon: '定时任务即将上线',
    nextRun: '下次',
    enabled: '已启用',
    paused: '已暂停',
    everyDay: '每天',
    everyWeek: '每周',
    run: '立即运行',
    edit: '编辑',
    remove: '删除',
    pausedToggle: '暂停',
    enableToggle: '启用',
    // 新建/编辑弹窗
    formNew: '新建定时任务',
    formEdit: '编辑定时任务',
    formContent: '让管家做什么',
    formContentPlaceholder: '例如:汇总昨天的营业数据,发我一份',
    formFreq: '频率',
    formTime: '时间',
    freqDay: '每天',
    freqWeek: '每周',
    freqMonth: '每月',
    save: '保存',
    cancel: '取消',
  },
  // 插件(能力/连接器 · 照 Codex/ChatGPT「Plugins / Connectors」)
  plugins: {
    title: '插件',
    subtitle: '给管家接上更多能力和外部服务。开箱内置这些,也能接你自己的 MCP 服务器。',
    add: '添加 MCP 服务器',
    comingSoon: 'MCP 服务器接入即将上线',
    builtinSection: '内置能力',
    connectorSection: '连接器',
    on: '已启用',
    off: '未启用',
    connect: '连接',
    manage: '管理',
    domainOn: '已挂载',
    domainOff: '挂载',
    // 添加 MCP 弹窗
    mcpTitle: '添加 MCP 服务器',
    mcpName: '名称',
    mcpNamePlaceholder: '例如:我的 GitHub',
    mcpTarget: '启动命令或地址',
    mcpTargetPlaceholder: '例如:npx -y @modelcontextprotocol/server-github',
    save: '保存',
    cancel: '取消',
    remove: '移除',
  },
  chat: {
    // ✓真机占位写法(owner 截图):今天帮你做些什么？ + @ 引用 + / 技能
    placeholder: '要求后续变更',        // Codex 跟进态占位
    placeholderNew: '随心输入',          // Codex 新任务态占位
    send: '发送',
    stop: '停止',
    thinking: '正在思考',
    working: '正在处理',
    running: '运行中…',
    connected: '已连接',
    connecting: '正在连接…',
    disconnected: '连接断开了,正在重连…',
    emptyHero: '今天帮你做些什么?',
    emptyHint: '让我读写文件、跑命令、上网查资料、生图,或者挂上「台球运营知识库」聊经营。',
    retry: '重试',
    runFailed: '这次没跑成:',
    maxTurns: '连着跑了好几个回合,先停下来喘口气。想接着做的话,回一句让它继续。',
    toolRunning: '执行中…',
    toolDone: '已完成',
    toolFailed: '出错了',
    footer: '内容由 AI 生成，请核实重要信息',  // ✓真机页脚,一字不差
    generating: '生成回复中',
    stepPrefix: '第',
    stepSuffix: '步',
    attach: '添加附件',
    mic: '语音输入',
    retryTitle: '重试中',
    retryWaiting: '等待重试…',
    fallbackTitle: '换个方式再等等',
    fallbackDetail: '这次没法边想边说,等完整结果',
  },
  thinking: {
    active: '正在思考',
    done: '已完成思考',
  },
  tools: {
    preparing: '准备中…',
    running: '正在执行',
    generating: '正在写内容',
    editing: '正在改文件',
    interrupted: '已中断',
    error: '出错了',
    toolInput: '调用参数',
    toolOutput: '执行结果',
    errorOutput: '错误信息',
  },
  toolGroup: {
    expand: '展开',
    collapse: '收起',
    done: '已完成',
  },
  tasks: {
    title: '任务清单',
    dismissCompleted: '收起清单',
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
    // 普通用户三档；规划模式只由 Agent 内部流程使用，不进入权限菜单。
    default: '默认权限',
    acceptEdits: '接受修改',
    plan: '规划模式',
    bypass: '完全访问',
    defaultDesc: '读取直接进行；修改文件和运行受控命令时请求确认',
    acceptEditsDesc: '工作目录内普通修改直接执行；命令、越界或敏感修改仍按需确认',
    planDesc: '只做规划、先不动手',
    bypassDesc: '可联网并修改电脑上的任意文件，不再逐次审批；系统授权仍由系统确认',
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
