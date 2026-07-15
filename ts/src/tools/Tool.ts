import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { AdditionalWorkingDirectory, ApprovalClass, ApprovalReason, PermissionMode, PermissionRule, PermissionUpdate } from '../permissions/types'
import type { TodoItem } from '../types/todo'
import type { Model } from '../types/model'
import type { DocumentBlock, ImageBlock, Message } from '../types/message'
import type { ToolRegistry } from './registry'
import type { ContentReplacementState } from '../context/toolResultStorage'
import type { DenialTrackingState } from '../permissions/denialTracking'
import type { HookRegistry } from '../hooks/hooks'

export interface FileReadSnapshot {
  path: string
  mtimeMs: number
  size: number
}

export interface ToolProgressEvent {
  type?: 'tool_progress'
  tool?: string
  id?: string
  stream?: 'stdout' | 'stderr' | string
  chunk: string
}

export interface ToolApprovalRequest {
  id: string
  tool: string
  args: unknown
  token: string
  rememberable: boolean
}

export type ToolApprovalResolution =
  | { behavior: 'allow'; remember: boolean }
  | { behavior: 'deny'; message?: string }

export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolContext {
  workspace: Workspace
  /** 当前会话模型出口,供 prompt/agent hooks、子代理等内核扩展执行非流式校验。 */
  model?: Model
  /** 当前会话工具注册表,供 agent hooks 启动受限 verifier agent。 */
  registry?: ToolRegistry
  signal?: AbortSignal
  sandbox?: Sandbox
  /** 权限档,默认 'default'。W4a 权限瀑布读它。 */
  permissionMode?: PermissionMode
  /** 当前 slash command / inline skill 通过 allowedTools 授权的会话内工具名。 */
  sessionAllowedTools?: Set<string>
  /** 当前 slash command / inline skill 通过 allowedTools 授权的参数级工具规则。 */
  sessionAllowedToolRules?: Array<{ tool: string; ruleContent: string }>
  /** CC-Haha 风格结构化权限规则,保留 source + allow/deny/ask,供设置/命令/会话共同进入同一瀑布。 */
  permissionRules?: PermissionRule[]
  /** 工作区外目录授权地基:本轮先承载 source/path,后续接完整 path validator 与 UI。 */
  additionalWorkingDirectories?: Map<string, AdditionalWorkingDirectory>
  /** 当前 slash command / inline skill 注册的会话内 hooks。 */
  sessionHooks?: HookRegistry
  /**
   * 前台会话的阻塞式审批桥:工具需要确认时暂停当前调用和 Agent 循环,
   * 用户允许/拒绝后从同一个 tool_use 原地继续。后台或独立调用不注入时保留旧的提案模式。
   */
  waitForApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalResolution>
  /** “本次对话都允许”产生的会话级规则回传给宿主持久在当前进程会话中。 */
  onPermissionUpdates?: (updates: PermissionUpdate[]) => void
  /** 会话内 hooks 变化时通知宿主持久化。 */
  onSessionHooksChanged?: (hooks: HookRegistry | undefined) => void
  /**
   * 当前调用可见的完整 hook 注册表(配置文件级 opts.hooks + 会话级 sessionHooks 的合并快照;
   * executeAllowedToolCall 执行期注入、执行完恢复,模式同 imageResultSink)。供工具在 execute 内
   * 触发生命周期 hook(TaskCreated/TaskCompleted/WorktreeCreate/WorktreeRemove/ConfigChange 等,
   * 对齐 cc 在对应工具/服务内 fire 这些事件)。
   */
  activeHooks?: HookRegistry
  /** 会话 id,跨请求拒绝计数按它隔离(见 denialTracking)。 */
  conversationId?: string
  /**
   * 状态根目录(stateRoot):file-history 快照挪出用户工作区、别污染用户 git 仓库。
   * 缺省时 file-history 回退到工作区 `.agent-file-history`(向后兼容,独立跑工具用)。
   */
  stateRoot?: string
  /**
   * 当前正在处理的消息 uuid(= transcript 事件日志里这条 assistant 消息的 uuid)。file-history 快照按它绑定,
   * 支持 message 级 rewind(对齐 cc 以 messageId 为键的 fileHistory)。主循环发起工具调用前置好;缺省则退回按会话兜底。
   */
  messageId?: string
  /** 当前工具调用前的模型消息快照,供 fork/subagent guard 等运行时逻辑判断父上下文。 */
  messages?: Message[]
  /** 当前主循环使用的 system prompt 快照,供 fork child 继承父提示词并保持缓存前缀。 */
  systemPrompt?: string
  /** 当前主循环最终渲染后的 system prompt,供 fork child byte-exact 继承。 */
  renderedSystemPrompt?: string
  /** 当前运行来源标记,用于 fork worker 在压缩后仍能识别自身身份。 */
  querySource?: string
  /** 子代理/后台 worker 本地拒绝与记住审批状态,避免污染父会话。 */
  localDenialTracking?: DenialTrackingState
  /** 当前任务清单(todo_write / task_progress 内联维护,单一真相源)。 */
  todos?: TodoItem[]
  /** 老板插话收件箱(FIFO,路由 push、循环在安全点 drain)。 */
  steerInbox?: string[]
  /** 距上次更新进度已连着调了几次工具(到 PROGRESS_REMIND_EVERY 提醒一次)。 */
  requestsSinceProgress?: number
  /** plan 模式下已过的工具批次数(每 PLAN_REMIND_EVERY 批注入一次 plan 提醒,节流,对齐 cc)。 */
  planModeTurnCount?: number
  /** 读前置编辑保护:read_file 记录快照,edit_file 改前校验 mtime/size 防覆盖外部改动。 */
  fileReads?: Map<string, FileReadSnapshot>
  /** 本轮已向模型展示过的目录级项目指令 scope,用于 write_file 新建文件前避免绕过子目录 AGENTS.md。 */
  projectInstructionScopes?: Set<string>
  /** 流式工具进度:run_command/慢工具在执行中向 Agent loop 推增量 UI 事件。 */
  progressEmit?: (event: ToolProgressEvent) => void
  /**
   * 单次工具执行的图像块收集器(真 vision 回灌):loop 在每次串行执行前置一个空数组、执行后收走,组进该
   * tool_result 的 content 块数组(text + image)。read_file 读图时把 vision 块推进来。
   * ⚠️ 只在串行执行路径一一对应(loop 设/取之间无交错);并行只读批次里读图工具被排除(见
   * prepareParallelReadOnlyCall),因此并行执行永不往此 sink 推、不会串图。非读图工具/文本结果不碰它(向后兼容)。
   */
  imageResultSink?: ImageBlock[]
  /** 整个用户回合可回灌给模型的图片体积/数量预算。 */
  imageResultBudget?: { remainingBytes: number; remainingImages: number }
  /** 整个用户回合可列给模型的图片候选数，防多次筛选变相遍历大目录。 */
  imageCandidateBudget?: number
  /**
   * 本轮(一批 tool_call)的 PDF 文档块收集器(PDF 视觉通道):read_file 读到 PDF 时把 document 块推进来,
   * loop 在组装本批 tool_result 的尾随 user 消息时把这些块作为顶层 ContentBlock 追加(对齐 cc 把 PDF 作为
   * 补充 document 消息喂给模型;因 document 不能进 tool_result content,只能走顶层块)。
   * ⚠️ 与 imageResultSink 不同:document 走"共享的本轮累加器",不需按单次执行一一对应(所有 PDF 读的块都汇入
   * 同一条尾随消息,顺序无所谓),故 PDF 读可留在并行只读批。loop 每批开始置空、组装尾随消息时清走。
   * 未设该 sink(脱离 loop 单测)时,read_file 仍回元信息文本(向后兼容,只是不回灌文档块)。
   */
  documentResultSink?: DocumentBlock[]
  /**
   * 官方 hooks 通用字段 continue:false 的批内暂存:PreToolUse/PostToolUse(Failure) 聚合出 haltReason 时
   * 由执行层写入(首个生效),主循环在批尾统一消费并优雅停轮,消费后清空。
   */
  hookHaltReason?: string
  /**
   * headless/后台上下文标志(对齐 cc shouldAvoidPermissionPrompts):置真时权限 ask 不弹审批卡,
   * PermissionRequest hook 无决策则自动拒绝(cc AUTO_REJECT 语义)。后台任务/记忆抽取 fork 等无人值守路径置真。
   */
  shouldAvoidPermissionPrompts?: boolean
  /** 当前会话的大工具结果落盘目录,供 read_stored_tool_result 安全回读。 */
  toolResultStoreDir?: string
  /** 大工具结果替换状态,供主循环/子代理/续跑保持一致的上下文裁剪决策。 */
  contentReplacementState?: ContentReplacementState
  /** ExitPlanMode 批准后登记的待验证计划,VerifyPlanExecution 用它防止“没验就收工”。 */
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
    toolCallsSinceApproval?: number
    lastStatus?: 'pass' | 'fail' | 'partial' | 'needs_evidence'
    lastReason?: string
  }
  /** EnterWorktree/ExitWorktree 会话态:创建隔离 git worktree 后临时切换当前工具工作区。 */
  worktreeSession?: {
    originalRoot: string
    worktreePath: string
    worktreeName: string
    worktreeBranch: string
    originalHeadCommit: string
    conversationId?: string
  }
  /** executeApproved 临时标记:某个顶层动作已经由用户确认,复合工具可据此执行同批内部步骤但仍保留 fatal/forceConfirm 红线。 */
  approvedToolExecution?: {
    name: string
    key: string
  }
}

/** 模型可见的工具描述(function-calling 线上格式)。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

/**
 * Tool——W2 的 name/description/schema/execute + isReadOnly,W4a 追加权限元数据(全可选)。
 * 缺省口径 = 直接放行:不设任何权限字段的工具永远 allow。
 * 需要受权限档控制或具备危险副作用的工具才设置 requiresApproval / forceConfirm / approvalClass。
 */
export interface Tool<Input = unknown> {
  name: string
  description: string
  inputSchema: JSONSchema
  isReadOnly: boolean
  /** 动态只读判定:同一个工具按入参可能是只读或会动手(run_command 是典型)。 */
  isReadOnlyFor?(input: Input, ctx: ToolContext): boolean
  /** 静态:该工具始终进入权限决策。 */
  requiresApproval?: boolean
  /** 审批类别,决定档位如何对待(见 ApprovalClass)。 */
  approvalClass?: ApprovalClass
  /** 动态审批类别:按具体入参区分 file/outreach/destructive。 */
  approvalClassFor?(input: Input, ctx: ToolContext): ApprovalClass | undefined
  /** 非完全访问档的强确认。bypassPermissions 按 Full access 语义跳过它。 */
  forceConfirm?: boolean
  /** 动态旁路免疫:同一个工具按入参区分预览/真正执行。 */
  forceConfirmFor?(input: Input, ctx: ToolContext): boolean
  /** 必须用户交互确认:连 bypassPermissions 也不能自动执行(例如原生系统授权)。 */
  requiresUserInteraction?: boolean
  requiresUserInteractionFor?(input: Input, ctx: ToolContext): boolean
  /** 动态:按具体入参决定要不要审批(如"写到工作区外才要")。 */
  requiresApprovalFor?(input: Input, ctx: ToolContext): boolean
  /** 硬拒理由:非空 = 直接拒、永不执行(SSRF/file:// 等安全漏洞防护)。 */
  fatalReasonFor?(input: Input, ctx: ToolContext): string | null
  /** 危险命令理由:非空 = 危险(rm -rf 根/format/mkfs 等)。对齐 cc:default/acceptEdits 档弹卡问、
   *  完全访问档放行、且 allow 规则不能让它免审批(比普通 needsApproval 强、比 fatal 弱)。 */
  dangerousReasonFor?(input: Input, ctx: ToolContext): string | null
  /** 安全白名单:命中则即便 requiresApproval 也放行(如只读子命令 `git status`)。 */
  safePrefixFor?(input: Input, ctx: ToolContext): boolean
  /** 审批卡预览(人话 diff),异步(可能要读文件算 diff)。 */
  previewFor?(input: Input, ctx: ToolContext): Promise<string | null>
  /** 审批卡理由(什么/为什么/影响)。 */
  approvalReasonFor?(input: Input, ctx: ToolContext): ApprovalReason
  /**
   * 可中断行为(对齐 cc interruptBehavior):'cancel' = 用户运行中插话时,若本工具正在飞,当场 abort 切断本回合
   * (submit-interrupt);缺省(未设)= 不可中断,插话入队、循环在安全点 drain(soft steer)。目前多为长等待类工具
   * (如 sleep/长轮询)才设它。
   */
  interruptBehavior?: 'cancel'
  execute(input: Input, ctx: ToolContext): Promise<string>
}
