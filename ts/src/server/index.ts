import { executeApproved, handleReject, runAgentLoop } from '../harness/loop'
import { resolveBundledDir } from '../harness/bundledRoot'
import { getWorkspaceGitStatus } from '../harness/env'
import { buildSystemPrompt } from '../harness/systemPrompt'
import { collectDiscoveryEntries, toPublicCommandEntries } from '../harness/skillListing'
import { summarizeWorkspaceProjectInstructions } from '../harness/projectInstructions'
import { scriptedModel } from '../harness/fakeModel'
import { compactPipeline } from '../context/compaction'
import { createModelFromProviderCandidates } from '../model/modelFactory'
import { getConfiguredOrBuiltInModelContextWindow } from '../model/modelContextWindows'
import {
  PUBLIC_TEXT_CHANNEL,
  publicProviderSummary,
  scrubProviderIdentifiers,
  toPublicProviderView,
} from '../model/publicModelNames'
import { createChatOutputScrubber } from '../harness/outputScrub'
import { SessionService, TurnRegistry, type SessionEventRecord, type SessionStatus, type SessionStreamEvent } from './services/sessionService'
import { SessionRewindService, type RewindTargetSelector } from './services/sessionRewindService'
import { ProviderService, type RuntimeProviderResolution } from './services/providerService'
import { ProviderHealthStore, type ProviderHealthEntry } from './services/providerHealthStore'
import { LegacyAgentStore, type LegacyArtifact } from './services/legacyAgentStore'
import { DesktopDataStore } from './services/desktopDataStore'
import { ScheduledTaskRunner } from './services/scheduledTaskRunner'
import { createTelemetryService } from './services/telemetry'
import { EMBEDDED_FRONTEND } from './embeddedFrontend'
import { UserSettingsStore } from './services/userSettings'
import { StoreDocsService, createStoreDocsTool } from './services/storeDocsService'
import {
  OfficeDocumentError,
  editCsvCell,
  editXlsxCell,
  isDocxPath,
  isPptxPath,
  isXlsxPath,
  readOfficeDocumentBlocks,
  readXlsxSheet,
  renderMinimalPptx,
  renderMinimalXlsx,
  saveOfficeDocumentBlocks,
} from '../utils/officeDocuments'
import { getLogger } from '../utils/logger'
import { jsonDetailError, jsonError, localCorsPreflight, TurnSetupError, withLocalCors } from './middleware/http'
import { VoiceTranscriptionError, transcribeVoiceFile } from './services/voiceTranscription'
import { buildGeneralRegistry } from '../tools/generalTools'
import { workspaceForActiveWorktree } from '../tools/worktreeTools'
import { activateConditionalSkillsForPaths, allowSkillTools, bundledSkillsRoot, FILE_TOUCH_TOOL_NAMES, formatUseSkillResult, loadLayeredSkills, loadSkillsDir, recordInvokedSkill, registerSkillHooks, toolInputFilePaths, userSkillsRoot } from '../skills/skillLoader'
import { createInvokedSkillsMessage, restoreInvokedSkillsFromMessages } from '../skills/invokedSkills'
import { createBuiltinCommandLibrary, isBuiltinForkCommand } from '../commands/builtinCommands'
import { allowedToolsForAgent } from '../commands/allowedTools'
import { bridgeUnsafeCommandMessage, type CommandLibrary, filterBridgeSafeCommands, isBridgeSafeCommand, loadCommandsDir, loadCommandsFromRoots, mergeCommandLibraries, normalizeCommandName, parseCommandInvocation, publicCommand } from '../commands/commandLoader'
import type { PromptCommand } from '../commands/types'
import { loadPluginHookRegistry, loadWorkspaceHookRegistry } from '../hooks/hookConfig'
import { applyElicitationHooks, applyElicitationResultHooks, applySessionEndHooks, applyUserPromptExpansionHooks, configureHookTrust, type HookRegistry as ElicitationHookRegistry } from '../hooks/hooks'
import { createDomainPackCommandLibrary, createDomainPackTools, listPublicDomainPacks, mergeEnabledPacks, mergeHookRegistries, packIdForCommandName, registerDomainPackCommandAliases, resolveEnabledPacks, suggestedSkillNamesForPacks, type DomainPack } from '../packs/domainPacks'
import { clearThreadGoalHook, createGoalHookRegistry, ensureThreadGoalHookFromTranscript, getThreadGoal, parseGoalCommand, setThreadGoalHook } from '../goals/goalState'
import { loadAgentsDir, type AgentDefinition } from '../agents/agentLoader'
import { createAgentTaskSidechainTools, createAgentTaskTool } from '../agents/agentTool'
import { buildForkRunContext } from '../agents/forkSubagent'
import {
  closeMcpConnections,
  defaultElicitationHandler,
  loadMcpToolsFromFile,
  type McpElicitationHandler,
  type McpElicitationHandlerInput,
  type McpSamplingHandlerInput,
} from '../mcp/client'
import { loadMcpConfigFile } from '../mcp/config'
import { addMcpServer, defaultWritableMcpConfigPath, MCP_PRESETS, removeMcpServer, setMcpServerDisabled } from '../mcp/configStore'
import { TaskService, type TaskMeta, type TaskStatus } from '../tasks/taskService'
import { TaskListService } from '../tasks/taskListService'
import { createBackgroundAgentTaskTool, createTaskTools, resumeBackgroundAgentTask, startBackgroundAgentRun, type BackgroundAgentTaskOptions } from '../tasks/taskTools'
import { createStructuredTaskTools } from '../tasks/taskListTools'
import { TeamService } from '../tasks/teamService'
import { createTeamTools } from '../tasks/teamTools'
import { startUdsInbox, type UdsInboxServer } from '../tasks/udsInbox'
import { UdsPeerRegistry, type UdsPeerRecord } from '../tasks/udsPeerRegistry'
import { BridgePeerRegistry } from '../tasks/bridgePeerRegistry'
import { BridgeRemoteState, type BridgeRemoteCredentialRecord, type BridgeRemotePermissionResponse, type BridgeRemotePermissionStatus, type BridgeRemoteOutboxStatus } from '../tasks/bridgeRemoteState'
import { bridgeRemoteConfigFromEnv, createBridgeRemoteTransport } from '../tasks/bridgeRemoteTransport'
import { BridgeRemoteSubscriber, type BridgeRemoteWebSocketConstructor } from '../tasks/bridgeRemoteSubscriber'
import { createBridgeCodeSessionClient } from '../tasks/bridgeCodeSessionClient'
import { BridgeWorkerClient, type BridgeWorkerSessionState } from '../tasks/bridgeWorkerClient'
import { BridgeWorkerStream } from '../tasks/bridgeWorkerStream'
import { BridgeWorkerRefreshScheduler, type BridgeWorkerRefreshCause } from '../tasks/bridgeWorkerRefreshScheduler'
import { projectBridgeSdkEvent } from '../tasks/bridgeSdkEventProjection'
import { resolveInboundUserMessage, type BridgeInboundContent, type BridgeResolvedInboundMessage } from '../tasks/bridgeInboundMessages'
import { MediaJobService, resolveMediaBackendUrl, type MediaJobKind } from '../media/mediaJobs'
import { ImageWorkbenchStore } from '../media/imageWorkbenchStore'
import { createImageWorkbenchRouteHandler } from '../media/imageWorkbenchRoutes'
import { saveLocalImageAttachment } from '../media/imageUploadRoutes'
import { localStoryboard } from '../media/studioFallbacks'
import { AssetManager, ASSET_WS_TOPIC, getActiveAssetManager, setActiveAssetManager } from '../assets/assetManager'
import { createMediaTools } from '../media/mediaTools'
import { VideoEditError, VideoEditProjectStore } from '../media/video-edit/legacyTimeline'
import { VideoEditingService } from '../media/video-edit/service'
import { createVideoEditRouteHandler } from '../media/video-edit/routes'
import { loadOutputStyles, publicOutputStyle, resolveOutputStyleConfig } from '../outputStyles/outputStyleLoader'
import { defaultPluginInstallDir, defaultPluginRoots, installPluginFromGithub, listPlugins, resolveEnabledPluginContributions, resolveEnabledPluginHookConfigPaths, setPluginEnabled } from '../plugins/pluginLoader'
import { LIBRARY_DIR_ENV, LIBRARY_DOT_DIR, LIBRARY_SUBDIR, getDefaultWorkspaceDir } from '../harness/desktopEnvNames'
import { WorkspaceNameError, createNamedWorkspace } from '../workspace/workspaceProvision'
import { TurnConsumerTracker } from './turnConsumerTracker'
import { Workspace } from '../workspace/workspace'
import { Sandbox } from '../sandbox/sandbox'
import { McpTrustStore, resolveTrustedMcpConfig } from '../mcp/mcpTrust'
import { runMigrations } from '../migrations'
import type { AssistantStep, Model } from '../types/model'
import { textBlock, type ContentBlock, type Message } from '../types/message'
import type { AgentEvent, AskQuestionField } from '../types/events'
import { parseClientMessage, type ServerMessage as AgentServerMessage } from '../../shared/contracts/agent-websocket'
import { voiceTranscriptionResponseSchema } from '../../shared/contracts/voice'
import {
  imageBriefCompileRequestSchema,
  imageBriefCompileResponseSchema,
  studioEditRequestSchema,
  studioGenerateRequestSchema,
  studioUpscaleRequestSchema,
} from '../../shared/contracts/image-workbench'
import type { ToolContext } from '../tools/Tool'
import type { PermissionUpdate } from '../permissions/types'
import { applyPermissionUpdates } from '../permissions/permissionUpdate'
import { configurePermissionTrust, loadPermissionRules, permissionUpdatesFromRules, persistPermissionRule } from '../permissions/permissionsSettings'
import type { FetchLike } from '../proxy/ProxyModel'
import type { PermissionMode } from '../permissions/types'
import { canonicalPermissionMode } from '../permissions/canonical'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { getAutoMemDir, getUserConfigHomeDir, MEMORY_DOT_DIR } from '../harness/memoryNames'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'

function sseLine(ev: SessionStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

function sseReplayLine(seq: number, ev: SessionStreamEvent): string {
  return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

function legacySseLine(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export interface StartServerOptions {
  host?: string
  port?: number
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  transcriptRoot?: string
  providerRoot?: string
  /** OS 沙箱(seatbelt/bwrap)写围栏:默认开(owner 2026-07-09),env QF_OS_SANDBOX=0 或此项 false 关。
   * 缺依赖/环境不支持时 Sandbox.wrapCommand 自动优雅降级为明文执行,绝不阻断命令。 */
  sandboxEnabled?: boolean
  /** WS 断连宽限期(ms):最后消费者断连后无人重连则中止运行中回合。默认 5 分钟,QF_TURN_ABANDON_GRACE_MS 可覆盖。 */
  turnAbandonGraceMs?: number
  /** ts-desktop 前端静态资源根目录;设置后 GET 未命中 API 路由时从此服务(Electron/浏览器加载前端)。默认 ts/desktop/renderer。 */
  frontendRoot?: string
  skillsRoot?: string
  commandsRoot?: string
  hooksPath?: string
  agentsRoot?: string
  mcpConfigPath?: string
  mediaBackendUrl?: string
  /** 资产管理器注入(测试用);缺省按 stateRoot/env/fetchImpl 自建。 */
  assetManager?: AssetManager
  /** 是否启动后台资产下载调度。默认:测试环境(NODE_ENV=test)不启,其余启;
   * env QF_ASSETS_AUTOSTART=0 可显式关(开发机不想联网下资产时)。 */
  assetAutoStart?: boolean
  /** 是否启动定时任务调度引擎(到点起真 agent 会话)。默认:测试环境不启,其余启;env QF_SCHEDULER=0 显式关。 */
  scheduledTasksAutoStart?: boolean
  bridgeWebSocketCtor?: BridgeRemoteWebSocketConstructor
  /** 启动即预先受信的工作区根(桌面壳打开已批准的库/工作区时注入,或测试用):等价对每个根调 mcpTrust.trust(root)。
   * 受信后该工作区来源的 local hook(.claude/hooks.json 等)才被信任门放行执行。 */
  trustedWorkspaceRoots?: string[]
}

interface WorkspaceTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: WorkspaceTreeEntry[]
  truncated?: boolean
}

type TurnStreamInput = Record<string, unknown> & {
  message?: unknown
  userMessage?: unknown
  conversationId?: unknown
  userContent?: ContentBlock[]
  messagePreview?: string
  skipCommandParsing?: boolean
  skipSlashCommands?: boolean
  bridgeOrigin?: boolean
}

const WORKSPACE_TREE_SKIP = new Set([
  '.git',
  '.next',
  '.agent-state',
  '.cache',
  '.mypy_cache',
  '.playwright-cli',
  '.pytest_cache',
  '.ruff_cache',
  '.superpowers',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'output',
])

// 原始文件字节预览的 content-type(右面板 <img> 渲染图片、pdf 等):按扩展名给,查不到走 octet-stream。
const RAW_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf',
}

async function summarizeWorkspaceTree(root: string, opts: { maxDepth?: number; maxEntries?: number } = {}) {
  const maxDepth = opts.maxDepth ?? 2
  const maxEntries = opts.maxEntries ?? 400
  let total = 0
  let truncated = false

  // ⚠️ 顶层(depth 0)永不因预算腰斩:此前是纯深度优先 + 总预算(120),排在前面的目录(如 .claude/.github)
  // 一递归就把预算吃光,轮不到 ts/ docs/ 这些真正重要的顶层目录 → 文件树只显示头几个点目录=废。
  // 现在保证同级(尤其顶层)条目全部露出,预算只管"深层要不要展开";深层没展开的目录留 children 为 undefined,
  // 前端点开时按 fs/list 懒加载(契约已验证),既不丢顶层、又不无限膨胀。
  async function walk(dir: string, depth: number): Promise<WorkspaceTreeEntry[]> {
    let entries = await readdir(dir, { withFileTypes: true })
    entries = entries
      .filter(entry => entry.name !== '.DS_Store')
      .filter(entry => !(entry.isDirectory() && WORKSPACE_TREE_SKIP.has(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-Hans-CN'))

    const out: WorkspaceTreeEntry[] = []
    for (const entry of entries) {
      // 只有深层(depth>0)才受预算约束;顶层一律全列(顶层条目数=目录实际数,通常可控)。
      if (depth > 0 && total >= maxEntries) {
        truncated = true
        break
      }
      const abs = resolve(dir, entry.name)
      const item: WorkspaceTreeEntry = {
        name: entry.name,
        path: relative(root, abs) || entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }
      total += 1
      if (entry.isDirectory() && depth < maxDepth) {
        if (total >= maxEntries) {
          // 预算已尽:不预展开,标记 truncated,children 留空 → 前端点开时懒加载,不丢这个目录本身。
          truncated = true
          item.truncated = true
        } else {
          item.children = await walk(abs, depth + 1)
          if (item.children.some(c => c.truncated)) item.truncated = true
        }
      }
      out.push(item)
    }
    return out
  }

  try {
    return { root, entries: await walk(root, 0), total, truncated }
  } catch (err) {
    return { root, entries: [], total: 0, truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

interface AgentWsData {
  conversationId: string
  after: number
}

function permissionModeFrom(value: unknown): PermissionMode {
  return canonicalPermissionMode(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()) : []
}

function messageText(message: Message): string {
  return message.content
    .map(block => {
      if (block.type === 'text') return block.text
      if (block.type === 'thinking') return block.thinking
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function inboundContentBlocks(content: BridgeInboundContent): ContentBlock[] {
  return typeof content === 'string' ? [textBlock(content)] : content
}

function inboundContentPreview(content: BridgeInboundContent): string {
  if (typeof content === 'string') return content
  return content.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') return `[image ${block.source.media_type}]`
    if (block.type === 'tool_result') {
      // 多模态兼容:tool_result.content 现在可能是 string 或 blocks 数组(#46)。
      // string 直接返回;数组时逐块摘要(text 取正文、image 给中性占位),别把数组/对象原样塞进预览。
      if (typeof block.content === 'string') return block.content
      return block.content
        .map(inner => (inner.type === 'text' ? inner.text : `[image ${inner.source.media_type}]`))
        .filter(Boolean)
        .join('\n')
    }
    return `[${block.type}]`
  }).filter(Boolean).join('\n').trim()
}

function isSensitiveFilePath(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (name === '.env' || name.startsWith('.env.')) return true
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(name)) return true
  return /(secret|credential|token|password|api[_-]?key)/i.test(name)
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function runtimeProviderLabel(runtime: RuntimeProviderResolution): string {
  // 白标：saved-provider 用用户自设的名字（用户自建 BYOK、自己知道），
  // env/内置出口一律给中性代称，绝不回显 `环境变量:<真实模型>`。
  if (runtime.source === 'saved-provider') return runtime.providerName || runtime.providerId || PUBLIC_TEXT_CHANNEL.builtin
  return PUBLIC_TEXT_CHANNEL.builtin
}

function runtimeProviderKey(runtime: RuntimeProviderResolution): string {
  if (runtime.source === 'saved-provider' && runtime.providerId) return `saved:${runtime.providerId}`
  return `${runtime.source}:${runtime.config.apiFormat}:${runtime.config.baseUrl}:${runtime.config.model}`
}

function sanitizeProviderError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // 白标：除清 Bearer/api-key 外，再过 scrubProviderIdentifiers 清掉真实模型名/供应商/endpoint，
  // 保证这条错误进 health.lastError / 失败旁白后不泄底。
  return scrubProviderIdentifiers(
    raw
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'),
  ).slice(0, 180)
}

function createModelFromRuntimeProviders(
  runtimes: RuntimeProviderResolution[],
  fetchImpl?: StartServerOptions['fetchImpl'],
  health?: {
    onFailure?: (runtime: RuntimeProviderResolution, err: unknown) => void
    onSuccess?: (runtime: RuntimeProviderResolution) => void
  },
): Model {
  return createModelFromProviderCandidates(
    runtimes.map(runtime => ({
      label: runtimeProviderLabel(runtime),
      config: runtime.config,
      onFailure: err => health?.onFailure?.(runtime, err),
      onSuccess: () => health?.onSuccess?.(runtime),
    })),
    { fetchImpl },
  )
}

const LEGACY_BYOK_TEXT_PROVIDER_ID = 'byok-text'

function validateImageModelPayload(body: Record<string, unknown>) {
  // 白标：BYOK 生图设置校验只回一个通用结论，绝不回显真实 provider 名或 known_models
  // （原来会吐 openai/volcengine + gpt-image-2/doubao-seedream-* 硬编码真名）。
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    return { ok: false, level: 'warning', message: '缺少生图模型名。' }
  }
  return { ok: true, level: 'info', message: '已记录生图模型设置。' }
}

/** app 内置技能根(=cc bundled skills):`ts/src/skills/bundled`。旧值指向已删的 server/skills → 写盘/加载全废,已修。 */
function defaultSkillsRoot(): string {
  return bundledSkillsRoot()
}

// SessionEnd 落点(对齐参考实现 executeSessionEndHooks:会话结束时触发,fire-and-forget)。
// 宿主在"用户删除会话"处调用:载荷带结束原因,失败/超时都不拖垮删除主流程。用最小 ToolContext
// (无 model——SessionEnd 一般是命令/清理类钩子;若配了 agent/prompt 钩子会因缺 model 优雅降级为非阻塞提示)。
// hooks 配置走三级加载(loadWorkspaceHookRegistry:~/.billiardbuddy/settings.json + 工作区
// .billiardbuddy/settings.json + settings.local.json,取代已删除的死路径 server/hooks.json——
// 该目录随老 Python server/ 一并删除,旧 defaultHooksPath() 恒 undefined,SessionEnd 从未真正加载到过
// local hook)。project/local 两级来源钩子仍过工作区信任闸;工作区取显式全局默认工作区
// (getDefaultWorkspaceDir,不选文件夹时的落点)。
async function fireSessionEndHooks(conversationId: string, reason: string): Promise<void> {
  try {
    const registry = await loadWorkspaceHookRegistry(getDefaultWorkspaceDir())
    if (!registry || registry.rules.length === 0) return
    const ctx: ToolContext = {
      workspace: new Workspace(getDefaultWorkspaceDir()),
      conversationId,
      permissionMode: 'default',
    }
    await applySessionEndHooks(registry, reason, ctx)
  } catch {
    // 忽略 SessionEnd 钩子异常,与参考实现的 fire-and-forget 语义一致。
  }
}

function defaultCommandsRoot(): string {
  // 内置 slash 命令(doctor/help/model/...)在 ts/commands。⚠️打包态走 resolveBundledDir(execPath 相对,
  // 否则编译二进制 cwd=userData / import.meta.dir=/$bunfs 都找不到,打包后内置命令静默消失)。
  return resolveBundledDir('commands', [
    join(process.cwd(), 'commands'),
    join(process.cwd(), 'ts', 'commands'),
    join(import.meta.dir, '..', '..', 'commands'),
  ])
}

function workspaceCommandRoots(workspaceRoot: string): string[] {
  // 白标铁律(绝不用 .claude,与记忆/指令/存储同走 .billiardbuddy 命名空间):工作区自定义命令读
  // `<ws>/.billiardbuddy/commands`。丁审计发现此前只读 .claude/.codex、与白标命名不一致,已收口。
  return [
    join(workspaceRoot, MEMORY_DOT_DIR, 'commands'),
  ].filter(existsSync)
}

async function loadCommandsForWorkspace(workspaceRoot: string, builtInRoot: string, packs: DomainPack[] = [], env: Record<string, string | undefined> = process.env) {
  const [builtInCommands, workspaceCommands] = await Promise.all([
    loadCommandsFromRoots([builtInRoot]),
    // 工作区来源命令的 frontmatter hooks 标 'local'(受信任门约束,防恶意仓库经命令 hooks RCE);
    // app 内置命令省略 → managed(可信)。与 skills 加载的信任分层同构。
    loadCommandsFromRoots(workspaceCommandRoots(workspaceRoot), 'local'),
  ])
  const merged = mergeCommandLibraries(builtInCommands, createBuiltinCommandLibrary(env), createDomainPackCommandLibrary(packs), workspaceCommands)
  // 合并会从 commands 数组重建 byName,丢掉领域包别名键;重新挂上让 /台球、/球房、/billiards 都能解析到入口命令。
  registerDomainPackCommandAliases(merged, packs)
  return merged
}

function localCommandMessage(name: string, args: string, output: string): Message {
  return {
    role: 'user',
    content: [textBlock([
      `<command-name>/${name}</command-name>`,
      `<command-args>${args}</command-args>`,
      '<local-command-stdout>',
      output,
      '</local-command-stdout>',
    ].join('\n'))],
  }
}

async function handleGoalCommand(conversationId: string, args: string, transcript: { load(): Promise<Message[]>; append(messages: Message[]): Promise<void> }): Promise<{ output: string; shouldQuery: boolean }> {
  const messages = await transcript.load()
  let parsed: ReturnType<typeof parseGoalCommand>
  try {
    parsed = parseGoalCommand(args)
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error)
    messages.push(localCommandMessage('goal', args, output))
    await transcript.append(messages)
    return { output, shouldQuery: false }
  }

  if (parsed.type === 'clear') {
    const existing = getThreadGoal(conversationId) ?? ensureThreadGoalHookFromTranscript(conversationId, messages)
    const cleared = clearThreadGoalHook(conversationId)
    const output = cleared || existing ? `Goal cleared: ${(cleared ?? existing)!.objective}` : 'No active goal.'
    messages.push(localCommandMessage('goal', args, output))
    await transcript.append(messages)
    return { output, shouldQuery: false }
  }

  const goal = setThreadGoalHook(conversationId, parsed.objective)
  const output = `Goal set: ${goal.objective}`
  messages.push(localCommandMessage('goal', args, output))
  await transcript.append(messages)
  return { output, shouldQuery: true }
}

function defaultAgentsRoot(): string {
  // app 内置 agents(=cc 的 getBuiltInAgents:general-purpose / Explore / Plan)。cc 把内置 agent 编进代码;
  // 我们放 `ts/src/agents/bundled/<name>.md`。⚠️打包态定位走 resolveBundledDir(execPath 相对,见其文档:
  // 编译二进制 import.meta.dir=/$bunfs、cwd=userData 都失效,不修则打包后子代理静默蒸发)。
  return resolveBundledDir('agents', [
    join(import.meta.dir, '..', 'agents', 'bundled'),
    join(process.cwd(), 'src', 'agents', 'bundled'),
    join(process.cwd(), 'ts', 'src', 'agents', 'bundled'),
  ])
}

function defaultMcpConfigPath(workspaceRoot: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const libraryDir = env[LIBRARY_DIR_ENV]
  const candidates = [
    join(workspaceRoot, '.mcp.json'),
    ...(libraryDir ? [join(libraryDir, '.mcp.json')] : []),
    join(env.HOME || env.USERPROFILE || process.cwd(), LIBRARY_DOT_DIR, LIBRARY_SUBDIR, '.mcp.json'),
    join(process.cwd(), '.mcp.json'),
  ]
  return candidates.find(existsSync)
}

function providerStatusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('not found')) return 404
  if (message.includes('already exists')) return 409
  if (message.includes('cannot delete active')) return 409
  if (message.includes('cannot activate disabled')) return 409
  if (message.includes('required') || message.includes('unsupported') || message.includes('非法')) return 400
  return 500
}

function providerPath(url: URL): { matched: boolean; segments: string[] } {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'providers') return { matched: true, segments: segments.slice(1) }
  if (segments[0] === 'api' && segments[1] === 'providers') return { matched: true, segments: segments.slice(2) }
  return { matched: false, segments: [] }
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function taskStatusFrom(value: unknown): TaskStatus | undefined {
  return value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled'
    ? value
    : undefined
}

function bridgePermissionStatusFrom(value: unknown): BridgeRemotePermissionStatus | undefined {
  return value === 'pending' || value === 'allowed' || value === 'denied' || value === 'cancelled'
    ? value
    : undefined
}

function bridgeOutboxStatusFrom(value: unknown): BridgeRemoteOutboxStatus | undefined {
  return value === 'queued' || value === 'sent' ? value : undefined
}

function bridgeWorkerSessionStateFrom(value: unknown): BridgeWorkerSessionState | undefined {
  return value === 'idle' || value === 'running' || value === 'requires_action'
    ? value
    : undefined
}

function bridgePermissionResponseFrom(body: Record<string, unknown>): BridgeRemotePermissionResponse {
  const behavior = body.behavior
  if (behavior === 'allow') {
    return { behavior: 'allow', updatedInput: isRecord(body.updatedInput) ? body.updatedInput : isRecord(body.updated_input) ? body.updated_input : {} }
  }
  if (behavior === 'deny') {
    return { behavior: 'deny', message: stringOr(body.message, 'Permission denied') }
  }
  throw new Error('behavior required')
}

function bridgeRemoteConfigFromBody(rawBody: Record<string, unknown>, env: Record<string, string | undefined>) {
  const fromEnv = bridgeRemoteConfigFromEnv(env)
  const nested = isRecord(rawBody.bridgeRemote) ? rawBody.bridgeRemote : isRecord(rawBody.bridge_remote) ? rawBody.bridge_remote : {}
  const baseUrl = stringOr(rawBody.bridgeRemoteBaseUrl ?? rawBody.bridge_remote_base_url ?? nested.baseUrl ?? nested.base_url, '') || fromEnv?.baseUrl
  const token = stringOr(rawBody.bridgeRemoteToken ?? rawBody.bridge_remote_token ?? nested.token, '') || fromEnv?.token
  if (!baseUrl || !token) return null
  const timeoutRaw = rawBody.bridgeRemoteTimeoutMs ?? rawBody.bridge_remote_timeout_ms ?? nested.timeoutMs ?? nested.timeout_ms
  const timeoutMs = typeof timeoutRaw === 'number'
    ? timeoutRaw
    : typeof timeoutRaw === 'string'
      ? Number.parseInt(timeoutRaw, 10)
      : fromEnv?.timeoutMs
  return {
    baseUrl,
    token,
    orgUuid: stringOr(rawBody.bridgeRemoteOrgUuid ?? rawBody.bridge_remote_org_uuid ?? nested.orgUuid ?? nested.org_uuid, '') || fromEnv?.orgUuid,
    betaHeader: typeof rawBody.bridgeRemoteBetaHeader === 'string'
      ? rawBody.bridgeRemoteBetaHeader
      : typeof rawBody.bridge_remote_beta_header === 'string'
        ? rawBody.bridge_remote_beta_header
        : typeof nested.betaHeader === 'string'
          ? nested.betaHeader
          : typeof nested.beta_header === 'string'
            ? nested.beta_header
            : fromEnv?.betaHeader,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  }
}

function bridgeCodeSessionConfigFromBody(rawBody: Record<string, unknown>, env: Record<string, string | undefined>) {
  const remote = bridgeRemoteConfigFromBody(rawBody, env)
  if (!remote) return null
  return {
    baseUrl: remote.baseUrl,
    token: remote.token,
    timeoutMs: remote.timeoutMs,
  }
}

function bridgeRefreshConfigFromBody(rawBody: Record<string, unknown>) {
  const nested = isRecord(rawBody.bridgeRefresh) ? rawBody.bridgeRefresh : isRecord(rawBody.bridge_refresh) ? rawBody.bridge_refresh : {}
  const enabledRaw = rawBody.bridgeRefreshEnabled ?? rawBody.bridge_refresh_enabled ?? nested.enabled
  if (enabledRaw === false || enabledRaw === 'false' || enabledRaw === 0 || enabledRaw === '0') return { enabled: false }
  return {
    enabled: true,
    refreshBufferMs: numberFrom(rawBody.bridgeRefreshBufferMs ?? rawBody.bridge_refresh_buffer_ms ?? nested.refreshBufferMs ?? nested.refresh_buffer_ms, 5 * 60 * 1000),
    minDelayMs: numberFrom(rawBody.bridgeRefreshMinDelayMs ?? rawBody.bridge_refresh_min_delay_ms ?? nested.minDelayMs ?? nested.min_delay_ms, 30_000),
    retryDelayMs: numberFrom(rawBody.bridgeRefreshRetryDelayMs ?? rawBody.bridge_refresh_retry_delay_ms ?? nested.retryDelayMs ?? nested.retry_delay_ms, 60_000),
    maxConsecutiveFailures: numberFrom(rawBody.bridgeRefreshMaxFailures ?? rawBody.bridge_refresh_max_failures ?? nested.maxConsecutiveFailures ?? nested.max_consecutive_failures, 3),
  }
}

function fallbackEventRecord(event: SessionStreamEvent): SessionEventRecord {
  return { seq: 0, ts: new Date().toISOString(), event }
}

function supportContext(rawBody: Record<string, unknown>): string {
  const blocks: string[] = []
  const selectedFiles = stringArray(rawBody.selected_files ?? rawBody.selectedFiles)
  if (selectedFiles.length > 0) {
    blocks.push(`<selected_files>\n${selectedFiles.map(file => `- ${file}`).join('\n')}\n</selected_files>`)
  }
  const goal = stringOr(rawBody.goal, '')
  if (goal) {
    blocks.push(`<user_goal>\n${goal}\n</user_goal>`)
  }
  if (rawBody.deep_thinking === true || rawBody.deepThinking === true) {
    blocks.push('用户打开了深度思考。遇到多步骤任务时，先简短拆解，再动手执行；不要只给建议。')
  }
  return blocks.length > 0 ? blocks.join('\n\n') : ''
}

function workspaceFromBody(rawBody: Record<string, unknown>): Workspace {
  const root = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
  // 主 agent 读放行 carve-out(对齐 cc filesystem.ts isAutoMemFile 放行):AutoMem 记忆目录在
  // 工作区之外(~/.billiardbuddy/projects/<slug>/memory),把它加进 allowedPaths,模型才能 grep/read_file
  // 读回自己写的记忆(与写侧 save_memory、常驻索引读侧派生同一目录)。先 mkdir 保证它作为「目录」被放行。
  const memoryDir = getAutoMemDir(new Workspace(root).root)
  try { mkdirSync(memoryDir, { recursive: true }) } catch { /* 记忆目录创建尽力而为,失败不阻塞会话 */ }
  return new Workspace(root, {
    allowedPaths: [...stringArray(rawBody.selected_files ?? rawBody.selectedFiles), memoryDir],
    fullDiskAccess: rawBody.full_disk_access === true || rawBody.fullDiskAccess === true,
  })
}

function messagingSocketPathFrom(rawBody: Record<string, unknown>, env: Record<string, string | undefined>): string {
  return stringOr(
    rawBody.messagingSocketPath ?? rawBody.messaging_socket_path ?? rawBody.udsMessagingSocketPath ?? rawBody.uds_messaging_socket_path,
    '',
  ) || stringOr(env.CLAUDE_CODE_MESSAGING_SOCKET, '')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function stringifyForPrompt(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function mcpSamplingContentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(mcpSamplingContentText).filter(Boolean).join('\n')
  if (!content || typeof content !== 'object') return stringifyForPrompt(content)
  const block = content as Record<string, unknown>
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'image') return `[image mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'audio') return `[audio mimeType=${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}]`
  if (block.type === 'tool_use') {
    const name = typeof block.name === 'string' ? block.name : 'unknown'
    return `<mcp_sampling_tool_use name="${name}">\n${stringifyForPrompt(block.input)}\n</mcp_sampling_tool_use>`
  }
  if (block.type === 'tool_result') {
    const id = typeof block.toolUseId === 'string' ? block.toolUseId : ''
    // 多模态兼容:tool_result.content 可能是 string 或 blocks 数组(#46)。string 直接取用;
    // 数组/其它形态交给本函数递归摘要(Array.isArray + typeof 分支已覆盖),不会 crash 也不产出 [object Object]。
    const inner = typeof block.content === 'string' ? block.content : mcpSamplingContentText(block.content)
    return `<mcp_sampling_tool_result id="${id}">\n${inner}\n</mcp_sampling_tool_result>`
  }
  if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
    const resource = block.resource as Record<string, unknown>
    if (typeof resource.text === 'string') return resource.text
    if (typeof resource.uri === 'string') return `[resource uri=${resource.uri}]`
  }
  if (typeof block.uri === 'string') return `[resource_link uri=${block.uri}]`
  return stringifyForPrompt(block)
}

function mcpSamplingMessages(messages: McpSamplingHandlerInput['params']['messages']): Message[] {
  return messages.map(message => ({
    role: message.role,
    content: [textBlock(mcpSamplingContentText(message.content))],
  }))
}

async function runMcpSampling(model: Model, modelName: string, params: McpSamplingHandlerInput['params'], signal?: AbortSignal) {
  const step = await model.step({
    system: params.systemPrompt,
    messages: mcpSamplingMessages(params.messages),
    tools: [],
    signal,
  })
  const text = step.kind === 'final'
    ? step.text
    : [
        step.text,
        step.calls.length > 0 ? `MCP sampling requested tool use, but this Agent only allows tool execution through the main permission gate: ${step.calls.map(call => call.name).join(', ')}` : '',
      ].filter(Boolean).join('\n\n')
  return {
    model: modelName || 'agent-model',
    role: 'assistant' as const,
    content: { type: 'text' as const, text },
    stopReason: step.kind === 'tool_calls' ? 'toolUse' as const : 'endTurn' as const,
  }
}

const MCP_ELICITATION_TIMEOUT_MS = 120000

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function schemaProperties(params: McpElicitationHandlerInput['params']): Record<string, unknown> {
  if (params.mode === 'url') return {}
  const schema = params.requestedSchema
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
}

function schemaRequired(params: McpElicitationHandlerInput['params']): string[] {
  if (params.mode === 'url') return []
  const schema = params.requestedSchema
  return Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
}

function primitiveDefault(value: unknown): string | number | boolean | string[] | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value
  return undefined
}

function defaultsForSchema(params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, prop] of Object.entries(schemaProperties(params))) {
    if (!isRecord(prop) || !Object.prototype.hasOwnProperty.call(prop, 'default')) continue
    const value = primitiveDefault(prop.default)
    if (value !== undefined) content[key] = value
  }
  return content
}

function coerceElicitationValue(raw: unknown, propSchema: unknown): string | number | boolean | string[] | undefined {
  const schema = isRecord(propSchema) ? propSchema : {}
  const type = schema.type
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') {
      const text = raw.trim().toLowerCase()
      if (['true', 'yes', 'y', '1', '允许', '是', '对'].includes(text)) return true
      if (['false', 'no', 'n', '0', '取消', '否', '不'].includes(text)) return false
    }
    return undefined
  }
  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
    if (!Number.isFinite(n)) return undefined
    return type === 'integer' ? Math.trunc(n) : n
  }
  if (type === 'array') {
    if (Array.isArray(raw) && raw.every(item => typeof item === 'string')) return raw
    if (typeof raw === 'string') return raw.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
    return undefined
  }
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return undefined
  return String(raw)
}

function parseKeyValueAnswer(answer: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of answer.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=：]+)\s*[:=：]\s*(.+?)\s*$/)
    if (match) out[match[1]!.trim()] = match[2]!.trim()
  }
  return out
}

function parseMcpFormAnswer(answer: string, params: McpElicitationHandlerInput['params']): Record<string, string | number | boolean | string[]> | null {
  if (params.mode === 'url') return null
  const properties = schemaProperties(params)
  const required = schemaRequired(params)
  const merged: Record<string, unknown> = { ...defaultsForSchema(params) }
  const trimmed = answer.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = parseKeyValueAnswer(trimmed)
  }
  if (isRecord(parsed) && Object.keys(parsed).length > 0) {
    Object.assign(merged, parsed)
  } else {
    const missing = required.filter(key => merged[key] === undefined)
    if (missing.length === 1) merged[missing[0]!] = trimmed
  }

  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [key, raw] of Object.entries(merged)) {
    const prop = properties[key]
    if (!prop) continue
    const value = coerceElicitationValue(raw, prop)
    if (value !== undefined) content[key] = value
  }
  if (required.some(key => content[key] === undefined)) return null
  return content
}

function mcpSchemaFieldLines(params: McpElicitationHandlerInput['params']): string[] {
  const required = new Set(schemaRequired(params))
  return Object.entries(schemaProperties(params)).map(([key, prop]) => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? ` - ${schema.description}` : ''
    const type = typeof schema.type === 'string' ? schema.type : 'value'
    const requiredMark = required.has(key) ? '必填' : '可选'
    const def = Object.prototype.hasOwnProperty.call(schema, 'default') ? `, 默认 ${stringifyForPrompt(schema.default)}` : ''
    return `- ${key} (${title}, ${type}, ${requiredMark}${def})${description}`
  })
}

function mcpSchemaFields(params: McpElicitationHandlerInput['params']): AskQuestionField[] | undefined {
  if (params.mode === 'url') return undefined
  const required = new Set(schemaRequired(params))
  const fields = Object.entries(schemaProperties(params)).map(([key, prop]): AskQuestionField => {
    const schema = isRecord(prop) ? prop : {}
    const title = typeof schema.title === 'string' ? schema.title : key
    const description = typeof schema.description === 'string' ? schema.description : undefined
    const enumOptions = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const arrayItemSchema = isRecord(schema.items) ? schema.items : {}
    const arrayOptions = Array.isArray(arrayItemSchema.enum) ? arrayItemSchema.enum.filter((item): item is string => typeof item === 'string') : undefined
    const type = schema.type === 'boolean'
      ? 'boolean'
      : schema.type === 'number' || schema.type === 'integer'
        ? 'number'
        : schema.type === 'array'
          ? arrayOptions?.length ? 'multiselect' : 'textarea'
          : enumOptions?.length ? 'select' : 'text'
    return {
      name: key,
      label: title,
      type,
      required: required.has(key),
      ...(description ? { description } : {}),
      ...(primitiveDefault(schema.default) !== undefined ? { defaultValue: primitiveDefault(schema.default) } : {}),
      ...((enumOptions?.length || arrayOptions?.length) ? { options: (enumOptions ?? arrayOptions)!.slice(0, 30) } : {}),
      ...(schema.type === 'array' && !arrayOptions?.length ? { placeholder: '每行一个值' } : {}),
    }
  })
  return fields.length > 0 ? fields : undefined
}

function isDeclineAnswer(answer: string): boolean {
  return ['取消', '拒绝', '不允许', 'decline', 'cancel', 'no', '否'].includes(answer.trim().toLowerCase())
}

async function waitForInboxAnswer(inbox: string[], startLen: number, signal?: AbortSignal, timeoutMs = MCP_ELICITATION_TIMEOUT_MS): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return null
    if (inbox.length > startLen) {
      const [answer] = inbox.splice(startLen, 1)
      return typeof answer === 'string' ? answer : null
    }
    await delay(100)
  }
  return null
}

function wsSend(ws: { send(data: string): unknown }, data: AgentServerMessage): void {
  try {
    ws.send(JSON.stringify(data))
  } catch {
    // WebSocket 可能已经断开;turn 继续跑并落 event log,下次连接 replay。
  }
}

function wsError(ws: { send(data: string): unknown }, message: string): void {
  wsSend(ws, { type: 'error', error: message })
}

function backgroundTaskNotification(task: TaskMeta): Record<string, unknown> | null {
  if (task.kind !== 'background_agent') return null
  const title = task.status === 'completed'
    ? '后台子代理已完成'
    : task.status === 'failed'
      ? '后台子代理失败'
      : task.status === 'cancelled'
        ? '后台子代理已取消'
        : null
  if (!title) return null
  return {
    title,
    body: task.error ? `${task.title}: ${task.error}` : task.title,
    kind: 'background_task',
    meta: {
      taskId: task.id,
      status: task.status,
      title: task.title,
      conversationId: task.conversationId,
      workspaceRoot: task.workspaceRoot,
      agent: typeof task.params?.agent === 'string' ? task.params.agent : undefined,
    },
  }
}

/**
 * 状态/会话根目录锚定(P0 · 打包后会话不丢)。
 * ⚠️ 绝不再默认用 process.cwd():开发时 cwd=项目目录能写,但打包后从 Finder/开始菜单启动 cwd=`/` 或
 * `/Applications`,写不下 → 会话/配置/transcript/tasks 全丢 = 分发即废。故默认锚到稳定的白标用户配置目录
 * `~/.billiardbuddy/state`(与 memoryNames.getUserConfigHomeDir() 对齐,env `BILLIARDBUDDY_CONFIG_DIR` 改配置根)。
 * 覆盖优先级:opts.transcriptRoot(测试/显式注入) > env `BILLIARDBUDDY_STATE_DIR`(白标显式覆盖整个 state 根)
 * > `~/.billiardbuddy/state`(默认,永远可写、与 cwd 无关)。
 */
/** 从会话历史里刨出被文件工具"碰过"的路径(供条件技能激活:碰到命中 paths 的文件才现身)。原语与 loop 侧共用(skillLoader)。 */
export function collectTouchedFilePaths(messages: Message[]): string[] {
  const paths: string[] = []
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !FILE_TOUCH_TOOL_NAMES.has(b.name)) continue
      paths.push(...toolInputFilePaths(b.input))
    }
  }
  return [...new Set(paths)]
}

export function resolveStateRoot(
  opts: { transcriptRoot?: string; env?: Record<string, string | undefined> } = {},
): string {
  if (opts.transcriptRoot && opts.transcriptRoot.length > 0) return opts.transcriptRoot
  const stateDirOverride = (opts.env ?? process.env).BILLIARDBUDDY_STATE_DIR
  if (stateDirOverride && stateDirOverride.length > 0) return stateDirOverride
  return join(getUserConfigHomeDir(), 'state')
}

/** W2/W6 后端。/health + /agent/hello(demo) + /agent/run(真实模型 Agent SSE)。 */
export function startServer(opts: StartServerOptions = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8850
  // OS 沙箱写围栏默认开(owner 2026-07-09);env QF_OS_SANDBOX=0 或 opts.sandboxEnabled=false 关。
  const sandboxEnabled = opts.sandboxEnabled ?? ((opts.env ?? process.env).QF_OS_SANDBOX !== '0')
  const buildSandbox = (ws: Workspace): Sandbox => new Sandbox({ workspace: ws, enabled: sandboxEnabled })
  const stateRoot = resolveStateRoot({ transcriptRoot: opts.transcriptRoot, env: opts.env })
  // MCP OAuth 令牌落盘目录(锚 stateRoot,跨会话/重启复用):所有 MCP 加载点共享;
  // 仅主对话(用户在场的 SSE 流)允许 interactive 授权,探测/列表/legacy 执行 interactive:false——
  // 复用已落盘令牌即可,绝不让"点开设置页/查列表"触发浏览器授权弹窗。
  const mcpOAuthDir = join(stateRoot, 'mcp-oauth')
  // 版本化 schema 迁移(#36 地基,对齐 cc main.tsx runMigrations):在任何 store 读 stateRoot 里的
  // settings/数据前,同步、按序、幂等地把待迁移的 schema 变更跑一遍,已应用版本记进 <stateRoot>/migrations.json。
  // 现注册表为空(cc 的具体迁移器都是给它上游模型改名、对我们不适用),故当前是空跑;地基就位,以后加一条即生效。
  // runMigrations 对运行期失败不抛(失败只记录、下次幂等重跑),再包一层 try/catch 兜住极端情况,绝不拖垮启动。
  try {
    runMigrations(stateRoot)
  } catch (err) {
    getLogger('migrations', { logDir: join(stateRoot, 'logs') }).warn(
      '启动迁移异常(不影响服务启动)',
      { error: err instanceof Error ? err.message : String(err) },
    )
  }
  // 工作区级 .mcp.json 信任闸(防恶意仓库 .mcp.json 自动 spawn 任意命令)。
  const mcpTrust = new McpTrustStore(join(stateRoot, 'mcp-trust.json'))
  for (const root of opts.trustedWorkspaceRoots ?? []) mcpTrust.trust(root)
  // SECURITY(P0 · 激活 hooks 信任门):本 server = 交互式桌面产品,默认即"信任必需"。
  // 把 hooks 执行前的信任门接到 McpTrustStore:交互(interactive:true)下、未受信工作区里、工作区来源(local)的
  // command/http/prompt/agent hook 一律不 spawn / 不执行(shouldRunHookRule 的 ②③ 闸);app 内置(managed)hook
  // 不受此门约束——理由见 hooks.ts shouldRunHookRule 注释的"与 cc 有意分叉"说明。受信授予入口:
  // POST /api/v1/agent/mcp/trust 或 startServer opts.trustedWorkspaceRoots。此调用是进程级、覆盖本 server 所有请求。
  configureHookTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
  // 权限 allow 规则同款信任门:未受信工作区的 .billiardbuddy allow 不生效(防恶意仓库绕审批闸),deny/ask 与用户级不受限。同一 McpTrustStore 信任源。
  configurePermissionTrust({ interactive: true, isWorkspaceTrusted: root => mcpTrust.isTrusted(root) })
  /** 解析并过信任闸的 mcpConfigPath。显式(请求或 startServer opts 指定)与 app 库/全局配置放行;
   * 未信任的工作区级 <root>/.mcp.json 拦下不连,返回 warning。 */
  const resolveMcpConfig = (rawBody: Record<string, unknown>, workspaceRoot: string): { path: string | undefined; warning?: string } => {
    const explicit = typeof rawBody.mcpConfigPath === 'string' && rawBody.mcpConfigPath.trim().length > 0
    const configPath = explicit ? String(rawBody.mcpConfigPath).trim() : opts.mcpConfigPath ?? defaultMcpConfigPath(workspaceRoot, opts.env ?? process.env)
    return resolveTrustedMcpConfig({ configPath, workspaceRoot, explicit: explicit || !!opts.mcpConfigPath, store: mcpTrust })
  }
  const sessions = new SessionService(stateRoot)
  const providers = new ProviderService(opts.providerRoot ?? stateRoot)
  const desktopData = new DesktopDataStore(stateRoot)
  const userSettings = new UserSettingsStore(stateRoot)
  const tasks = new TaskService(stateRoot, {
    onSettled: async task => {
      const notification = backgroundTaskNotification(task)
      if (notification) await desktopData.addNotification(notification)
    },
  })
  const taskLists = new TaskListService(join(stateRoot, 'task-lists'))
  const teams = new TeamService(stateRoot)
  const udsPeers = new UdsPeerRegistry(stateRoot)
  const bridgePeers = new BridgePeerRegistry(stateRoot)
  const bridgeRemote = new BridgeRemoteState(stateRoot)
  const imageWorkbench = new ImageWorkbenchStore(stateRoot)
  const media = new MediaJobService({
    tasks,
    stateRoot,
    backendUrl: opts.mediaBackendUrl ?? resolveMediaBackendUrl(opts.env ?? process.env),
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
    pollIntervalMs: 100,
    prepareImageBody: (body, mode) => prepareStudioImageBody(body, mode),
    workbenchStore: imageWorkbench,
  })
  const handleImageWorkbenchRoute = createImageWorkbenchRouteHandler(imageWorkbench)
  // 资产管理器(瘦安装包):大块头资产(ffmpeg/转写权重/中文字体)首启后从静态源后台
  // 静默下载;媒体调用点经进程级注册表拿 ready 路径。测试环境默认不启动(不碰网络)。
  const assets = opts.assetManager ?? new AssetManager({
    stateRoot,
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
  })
  setActiveAssetManager(assets)
  const assetAutoStart = opts.assetAutoStart ?? (process.env.NODE_ENV !== 'test' && (opts.env ?? process.env).QF_ASSETS_AUTOSTART !== '0')
  if (assetAutoStart) assets.start()
  const videoEdits = new VideoEditProjectStore(stateRoot)
  const videoEditing = new VideoEditingService({ stateRoot, tasks, env: opts.env ?? process.env })
  const handleVideoEditV2Route = createVideoEditRouteHandler(videoEditing, { defaultWorkspaceRoot: getDefaultWorkspaceDir() })
  const legacyStore = new LegacyAgentStore(stateRoot)
  const storeDocs = new StoreDocsService(desktopData, stateRoot)
  // 定时任务调度引擎(触发器)。到点 → 起一个真 agent 会话让模型在 cc 循环里用工具把任务干完(#66 衔接铁律,
  // 不是执行写死的 SOP 脚本)。fireTask 直接调进程内的 createTurnStream(= runAgentLoop),带任务配置的工作目录 +
  // 领域包(billiards_mode);无人值守故走 bypassPermissions(仍不越 forceConfirm/硬拒红线)。产出/状态写回运行历史。
  const scheduledTasks = new ScheduledTaskRunner({
    store: desktopData,
    stateRoot,
    fireTask: async (task, ctx) => {
      const instruction = typeof task.instruction === 'string' ? task.instruction.trim() : ''
      if (!instruction) return { status: 'failed', error: '定时任务没有指令内容,已跳过。' }
      const conversationId = crypto.randomUUID()
      const workingDir = stringOr(task.working_dir, getDefaultWorkspaceDir())
      let finalText = ''
      try {
        const { stream } = await createTurnStream({
          message: instruction,
          conversationId,
          working_dir: workingDir,
          billiards_mode: task.billiards_mode === true,
          permissionMode: 'bypassPermissions',
        })
        for await (const record of stream) {
          if (ctx.signal?.aborted) break
          if (record.event.type === 'final') finalText = record.event.text
        }
        return { status: 'completed', summary: finalText, conversationId }
      } catch (err) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err), conversationId }
      }
    },
  })
  const turns = new TurnRegistry()
  // rewind/checkpoint 上层服务(对标 cc-haha sessionRewindService,存储走 Transcript.rewindTo 的 append-only 分支模型)。
  const sessionRewind = new SessionRewindService(sessions, turns, stateRoot)
  // WS 断连宽限清理:最后一个消费者断连后,宽限期内无人重连则中止仍在跑的回合(防被遗弃的回合永远跑)。
  const turnGraceEnv = Number((opts.env ?? process.env).QF_TURN_ABANDON_GRACE_MS ?? '')
  const turnAbandonGraceMs = opts.turnAbandonGraceMs ?? (Number.isFinite(turnGraceEnv) && turnGraceEnv > 0 ? turnGraceEnv : 5 * 60 * 1000)
  const turnConsumers = new TurnConsumerTracker({
    graceMs: turnAbandonGraceMs,
    isRunning: id => turns.isRunning(id),
    abort: id => {
      if (turns.interrupt(id)) void sessions.touch(id, { status: 'interrupted' }).catch(() => undefined)
    },
  })
  const frontendRoot = opts.frontendRoot ?? join(import.meta.dir, '../../desktop/renderer')
  const FRONTEND_CT: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
  async function serveFrontendAsset(pathname: string): Promise<Response | null> {
    const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
    const resolved = resolve(frontendRoot, rel)
    // 防路径穿越:必须落在 frontendRoot 内(越界仍可走嵌入兜底命中已知文件)
    if (resolved === frontendRoot || resolved.startsWith(frontendRoot + sep)) {
      try {
        const data = await readFile(resolved)
        return new Response(data, { headers: { 'Content-Type': FRONTEND_CT[extname(resolved).toLowerCase()] ?? 'application/octet-stream' } })
      } catch {
        // 文件系统没有:编译态 frontendRoot 是虚拟 bunfs 路径,落到下面嵌入兜底。
      }
    }
    // 嵌入兜底:打包后 sidecar 二进制读不到真实 renderer 目录,从编进二进制的前端文件服务。
    const embedded = EMBEDDED_FRONTEND['/' + rel]
    if (embedded) return new Response(embedded.body, { headers: { 'Content-Type': embedded.contentType } })
    return null
  }
  const steerInboxes = new Map<string, string[]>()
  // 运行中"提交插话"时触发 submit-interrupt(对齐 cc handlePromptSubmit:hasInterruptibleToolInProgress → abort('interrupt'))。
  // 循环内 registerInterrupt 注册进来,自带闸(仅在可中断工具在飞时才真切断);普通工具在飞/无工具时为 no-op = 入队。
  const interruptRequesters = new Map<string, () => void>()
  const sessionSkillHooks = new Map<string, NonNullable<ReturnType<typeof mergeHookRegistries>>>()
  const sessionPermissionUpdates = new Map<string, PermissionUpdate[]>()
  const providerHealth = new ProviderHealthStore(opts.providerRoot ?? stateRoot)
  const bridgeSubscribers = new Map<string, BridgeRemoteSubscriber>()
  const bridgeWorkers = new Map<string, BridgeWorkerClient>()
  const bridgeWorkerStreams = new Map<string, BridgeWorkerStream>()
  const bridgeWorkerRefreshSchedulers = new Map<string, BridgeWorkerRefreshScheduler<BridgeWorkerRefreshValue>>()

  type BridgeWorkerStartResult = {
    worker: BridgeWorkerClient
    initialized: Awaited<ReturnType<BridgeWorkerClient['initialize']>>
    stream: BridgeWorkerStream | null
    streamEnabled: boolean
    initialSequence: number
  }
  type BridgeWorkerRefreshValue = {
    credentials: BridgeRemoteCredentialRecord
    started: BridgeWorkerStartResult
    status: number
  }

  function cancelBridgeWorkerRefresh(codeSessionId: string): void {
    bridgeWorkerRefreshSchedulers.get(codeSessionId)?.cancel()
    bridgeWorkerRefreshSchedulers.delete(codeSessionId)
  }

  function closeBridgeWorkerRuntime(codeSessionId: string, opts: { cancelRefresh?: boolean } = {}): void {
    if (opts.cancelRefresh) cancelBridgeWorkerRefresh(codeSessionId)
    bridgeWorkerStreams.get(codeSessionId)?.close()
    bridgeWorkerStreams.delete(codeSessionId)
    bridgeWorkers.get(codeSessionId)?.close()
    bridgeWorkers.delete(codeSessionId)
  }

  function bridgeWorkerRefreshStatus(codeSessionId: string) {
    return bridgeWorkerRefreshSchedulers.get(codeSessionId)?.getStatus() ?? {
      enabled: false,
      sessionId: codeSessionId,
      inFlight: false,
      nextRefreshAt: null,
      nextRefreshInMs: null,
      consecutiveFailures: 0,
      lastRefreshAt: null,
      lastError: null,
      lastCause: null,
    }
  }

  async function fetchAndStoreBridgeWorkerCredentials(codeSessionId: string, body: Record<string, unknown>) {
    const config = bridgeCodeSessionConfigFromBody(body, opts.env ?? process.env)
    if (!config) throw new TurnSetupError('bridge code session client is not configured', 400)
    const trustedDeviceToken = stringOr(body.trustedDeviceToken ?? body.trusted_device_token, '')
    const client = createBridgeCodeSessionClient({ ...config, fetchImpl: opts.fetchImpl })
    const fetched = await client.fetchRemoteCredentials(codeSessionId, trustedDeviceToken || undefined)
    if (!fetched.ok) throw new TurnSetupError(fetched.error, fetched.status ?? 502)
    const credentials = await bridgeRemote.storeCredentials(codeSessionId, fetched.value)
    return { credentials, status: fetched.status }
  }

  async function refreshBridgeWorkerCredentialsAndTransport(codeSessionId: string, body: Record<string, unknown>, _cause: BridgeWorkerRefreshCause, manageRefresh: boolean): Promise<BridgeWorkerRefreshValue> {
    const fetched = await fetchAndStoreBridgeWorkerCredentials(codeSessionId, body)
    const started = await startBridgeWorker(codeSessionId, fetched.credentials, body, { manageRefresh })
    return { ...fetched, started }
  }

  function scheduleBridgeWorkerRefresh(codeSessionId: string, body: Record<string, unknown>, credentials: BridgeRemoteCredentialRecord): void {
    const config = bridgeCodeSessionConfigFromBody(body, opts.env ?? process.env)
    const refreshConfig = bridgeRefreshConfigFromBody(body)
    cancelBridgeWorkerRefresh(codeSessionId)
    if (!config || !refreshConfig.enabled) return
    const scheduler = new BridgeWorkerRefreshScheduler<BridgeWorkerRefreshValue>({
      sessionId: codeSessionId,
      refreshBufferMs: refreshConfig.refreshBufferMs,
      minDelayMs: refreshConfig.minDelayMs,
      retryDelayMs: refreshConfig.retryDelayMs,
      maxConsecutiveFailures: refreshConfig.maxConsecutiveFailures,
      onRefresh: async cause => {
        const refreshed = await refreshBridgeWorkerCredentialsAndTransport(codeSessionId, body, cause, false)
        return { value: refreshed, expiresInSeconds: refreshed.credentials.expiresIn }
      },
    })
    bridgeWorkerRefreshSchedulers.set(codeSessionId, scheduler)
    scheduler.scheduleFromExpiresIn(credentials.expiresIn)
  }

  async function recoverBridgeWorkerStreamAuth(codeSessionId: string, code: number): Promise<void> {
    const scheduler = bridgeWorkerRefreshSchedulers.get(codeSessionId)
    if (!scheduler) {
      closeBridgeWorkerRuntime(codeSessionId, { cancelRefresh: true })
      await bridgePeers.updateStatus(codeSessionId, 'error', `worker stream closed ${code}`).catch(() => undefined)
      return
    }
    await bridgePeers.updateStatus(codeSessionId, 'connecting', `worker stream closed ${code}; refreshing`).catch(() => undefined)
    const result = await scheduler.refreshNow('auth_401_recovery')
    if (result.ok) return
    if (result.skipped && (result.reason === 'in_flight' || result.reason === 'stale')) return
    closeBridgeWorkerRuntime(codeSessionId, { cancelRefresh: result.skipped && result.reason === 'cancelled' })
    const detail = result.skipped ? result.reason : result.error
    await bridgePeers.updateStatus(codeSessionId, 'error', `worker stream refresh failed: ${detail}`).catch(() => undefined)
  }

  async function projectBridgeEventToConversation(rawBody: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
    const conversationId = stringOr(rawBody.conversationId ?? rawBody.conversation_id, '')
    if (!conversationId || payload.type === 'user') return
    const events = projectBridgeSdkEvent(payload)
    if (events.length === 0) return
    await sessions.touch(conversationId, {
      title: stringOr(rawBody.title, 'Remote Control Session'),
      workspaceRoot: stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir()),
      status: turns.isRunning(conversationId) ? 'running' : 'idle',
    }).catch(() => undefined)
    for (const event of events) {
      await sessions.appendEvent(conversationId, event).catch(() => undefined)
    }
  }

  async function startBridgeWorker(
    codeSessionId: string,
    credentials: BridgeRemoteCredentialRecord | null,
    body: Record<string, unknown> = {},
    options: { manageRefresh?: boolean } = {},
  ): Promise<BridgeWorkerStartResult> {
    if (!credentials) throw new Error('bridge credentials not found')
    const previousSequence = bridgeWorkerStreams.get(codeSessionId)?.getLastSequenceNum() ?? 0
    const initialSequence = numberFrom(body.initialSequenceNum ?? body.initial_sequence_num, previousSequence)
    const inboundConfig = bridgeRemoteConfigFromBody(body, opts.env ?? process.env)
    const manageRefresh = options.manageRefresh ?? true
    if (manageRefresh) cancelBridgeWorkerRefresh(codeSessionId)
    closeBridgeWorkerRuntime(codeSessionId)
    const worker = new BridgeWorkerClient({
      sessionId: codeSessionId,
      credentials,
      heartbeatIntervalMs: numberFrom(body.heartbeatIntervalMs ?? body.heartbeat_interval_ms, 20_000),
      heartbeatJitterFraction: typeof body.heartbeatJitterFraction === 'number'
        ? body.heartbeatJitterFraction
        : typeof body.heartbeat_jitter_fraction === 'number'
          ? body.heartbeat_jitter_fraction
          : 0,
      fetchImpl: opts.fetchImpl,
      onEpochMismatch: () => {
        closeBridgeWorkerRuntime(codeSessionId, { cancelRefresh: true })
        void bridgePeers.updateStatus(codeSessionId, 'error', 'worker epoch mismatch').catch(() => undefined)
      },
    })
    const initialized = await worker.initialize()
    if (!initialized.ok) {
      worker.close()
      throw new TurnSetupError(initialized.error || `worker init failed ${initialized.status ?? ''}`.trim(), initialized.status ?? 502)
    }
    bridgeWorkers.set(codeSessionId, worker)
    if (manageRefresh) scheduleBridgeWorkerRefresh(codeSessionId, body, credentials)
    const shouldStream = body.stream !== false && body.read_stream !== false
    if (shouldStream) {
      const stream = new BridgeWorkerStream({
        sessionId: codeSessionId,
        apiBaseUrl: credentials.apiBaseUrl,
        workerJwt: credentials.workerJwt,
        initialSequenceNum: initialSequence,
        fetchImpl: opts.fetchImpl,
      }, { state: bridgeRemote, worker, inbound: {
        stateRoot,
        baseUrl: inboundConfig?.baseUrl,
        token: inboundConfig?.token,
        fetchImpl: opts.fetchImpl,
        onResolved: async resolved => { await dispatchBridgeInboundToAgent({ ...body, bridgeSessionId: codeSessionId }, resolved) },
      } }, {
        onEvent: event => { void projectBridgeEventToConversation(body, event.payload) },
        onClose: code => {
          bridgeWorkerStreams.delete(codeSessionId)
          if (code === 401 || code === 403) {
            void recoverBridgeWorkerStreamAuth(codeSessionId, code).catch(err => {
              closeBridgeWorkerRuntime(codeSessionId, { cancelRefresh: true })
              void bridgePeers.updateStatus(codeSessionId, 'error', err instanceof Error ? err.message : String(err)).catch(() => undefined)
            })
          }
        },
      })
      bridgeWorkerStreams.set(codeSessionId, stream)
      stream.connect()
    }
    await bridgePeers.register({ sessionId: codeSessionId, status: 'connected', inboundEnabled: true })
    return { worker, initialized, stream: bridgeWorkerStreams.get(codeSessionId) ?? null, streamEnabled: shouldStream, initialSequence }
  }

  function registerProviderFailure(runtime: RuntimeProviderResolution, err: unknown): void {
    const key = runtimeProviderKey(runtime)
    providerHealth.recordFailure(key, runtimeProviderLabel(runtime), sanitizeProviderError(err))
  }

  function registerProviderSuccess(runtime: RuntimeProviderResolution): void {
    providerHealth.recordSuccess(runtimeProviderKey(runtime))
  }

  function orderRuntimeProvidersForAttempt(runtimes: RuntimeProviderResolution[]): { runtimes: RuntimeProviderResolution[]; notices: string[] } {
    const now = Date.now()
    const healthy: RuntimeProviderResolution[] = []
    const cooling: Array<{ runtime: RuntimeProviderResolution; health: ProviderHealthEntry }> = []
    for (const runtime of runtimes) {
      const key = runtimeProviderKey(runtime)
      const health = providerHealth.get(key, now)
      if (health) {
        cooling.push({ runtime, health })
      } else {
        healthy.push(runtime)
      }
    }
    if (healthy.length === 0 || cooling.length === 0) return { runtimes, notices: [] }
    // 白标：只在首选出口进冷却时给一句中性提示，去掉真实模型名（label）与原始报错（lastError）。
    const notices = cooling.some(item => item.runtime === runtimes[0])
      ? ['上个 AI 通道最近失败已进入冷却，本轮已自动优先使用可用通道继续。']
      : []
    return { runtimes: [...healthy, ...cooling.map(item => item.runtime)], notices }
  }

  const providerHealthCallbacks = {
    onFailure: registerProviderFailure,
    onSuccess: registerProviderSuccess,
  }

  async function resolveTaskEndpointTarget(id: string, statuses?: TaskStatus[]): Promise<{ task: TaskMeta | null; requestedTaskId: string }> {
    const resolution = await tasks.resolveBackgroundAgentTarget(id, {
      ...(statuses ? { statuses } : {}),
    })
    if (resolution.task) return { task: resolution.task, requestedTaskId: id }
    return { task: await tasks.get(id), requestedTaskId: id }
  }

  function taskAliasPayload(task: TaskMeta, requestedTaskId: string): Record<string, string> {
    const agentId = typeof task.params?.agent_id === 'string' && task.params.agent_id.trim()
      ? task.params.agent_id.trim()
      : ''
    return {
      ...(agentId ? { agentId } : {}),
      ...(requestedTaskId !== task.id ? { requestedTaskId, resolvedTaskId: task.id } : {}),
    }
  }

  function runtimeProviderHealthStatus(runtime: RuntimeProviderResolution, now = Date.now()) {
    const key = runtimeProviderKey(runtime)
    const health = providerHealth.get(key, now)
    if (!health) {
      return {
        source: runtime.source,
        providerId: runtime.providerId,
        providerName: runtime.providerName,
        label: runtimeProviderLabel(runtime),
        // 白标：不外露真实 model（原 runtime.config.model 会泄内置模型名）。
        state: 'ready',
        failureCount: 0,
        cooldownMsRemaining: 0,
      }
    }
    return {
      source: runtime.source,
      providerId: runtime.providerId,
      providerName: runtime.providerName,
      label: health.label,
      // 白标：不外露真实 model。
      state: 'cooling',
      failureCount: health.failureCount,
      cooldownMsRemaining: Math.max(0, health.cooldownUntil - now),
      lastError: health.lastError,
      failureCategory: health.failureCategory,
    }
  }

  async function syncLegacyByokTextProvider(input: Record<string, unknown>, saved: Record<string, unknown>): Promise<void> {
    const existing = await providers.get(LEGACY_BYOK_TEXT_PROVIDER_ID).catch(() => null)
    if (input.enabled !== true) {
      const list = await providers.list()
      if (existing && list.activeId === LEGACY_BYOK_TEXT_PROVIDER_ID) await providers.clearActive()
      return
    }

    const baseUrl = stringOr(saved.base_url, '').trim()
    const model = stringOr(saved.model, '').trim()
    const apiKey = stringOr(input.api_key, '').trim()
    if (!baseUrl || !model) return

    const payload = {
      id: LEGACY_BYOK_TEXT_PROVIDER_ID,
      name: '自带文字模型',
      apiFormat: 'openai_chat',
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
    }
    if (existing) await providers.update(LEGACY_BYOK_TEXT_PROVIDER_ID, payload)
    else {
      if (!apiKey) return
      await providers.create(payload)
    }
    await providers.activate(LEGACY_BYOK_TEXT_PROVIDER_ID)
  }

  async function currentModelStatus() {
    const [list, runtimes] = await Promise.all([
      providers.list(),
      providers.resolveRuntimeConfigs(opts.env ?? process.env),
    ])
    const ordered = orderRuntimeProvidersForAttempt(runtimes)
    const runtime = ordered.runtimes[0]
    const now = Date.now()
    const health = runtimes.map(item => runtimeProviderHealthStatus(item, now))
    return {
      ok: !!runtime,
      activeId: list.activeId,
      // 白标：providers 列表脱敏——去 baseUrl + 真实 model，只留身份 + 能力档代称。
      providers: list.providers.map(toPublicProviderView),
      fallbackCount: Math.max(0, runtimes.length - 1),
      coolingCount: health.filter(item => item.state === 'cooling').length,
      health,
      healthHistory: providerHealth.listHistory(8),
      runtime: runtime
        ? {
            source: runtime.source,
            providerId: runtime.providerId,
            providerName: runtime.providerName,
            // 白标:出口摘要走 publicProviderSummary(删 baseUrl/model/apiFormat,只给能力档)。
            summary: publicProviderSummary(runtime.config),
          }
        : null,
    }
  }

  async function clearModelHealth(body: Record<string, unknown>) {
    const all = body.all === true
    const providerId = stringOr(body.providerId, '')
    const source = stringOr(body.source, '')

    if (!all && !providerId && !source) {
      throw new Error('providerId/source required')
    }

    const runtimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    const matched = all
      ? runtimes
      : runtimes.filter(runtime => (
          providerId ? runtime.providerId === providerId : runtime.source === source
        ))
    if (!all && matched.length === 0) throw new Error('provider runtime not found')

    const cleared = all
      ? providerHealth.clearAll()
      : providerHealth.clearAll(matched.map(runtimeProviderKey))
    return { ok: true, cleared, status: await currentModelStatus() }
  }

  async function handleMcpElicitation(
    input: McpElicitationHandlerInput,
    elicitOpts: { conversationId: string; taskId?: string; signal?: AbortSignal; hooks?: ElicitationHookRegistry; workspaceRoot?: string },
  ) {
    // Elicitation/ElicitationResult hooks(对齐 cc executeElicitationHooks/executeElicitationResultHooks,
    // utils/hooks.ts:4489-4594):问用户之前给 hook 代答(accept/decline/cancel+content)或阻断的机会;
    // 拿到回答之后再过一遍结果钩(可改写/阻断回给服务器的结果)。无 hooks 时零行为变化。
    type ElicitationOutcome = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
    const hookCtx = elicitOpts.hooks && elicitOpts.workspaceRoot
      ? { workspace: new Workspace(elicitOpts.workspaceRoot), conversationId: elicitOpts.conversationId, signal: elicitOpts.signal } as Parameters<typeof applyElicitationHooks>[2]
      : null
    // params 是按 mode 判别的联合类型(url 变体才有 url、form 变体才有 requestedSchema),宽松收窄读字段。
    const rawParams = input.params as { message?: unknown; mode?: unknown; url?: unknown; requestedSchema?: unknown }
    const elicitationMode = rawParams.mode === 'url' ? 'url' as const : 'form' as const
    const finishElicitation = async (result: ElicitationOutcome): Promise<ElicitationOutcome> => {
      if (!hookCtx) return result
      const post = await applyElicitationResultHooks(elicitOpts.hooks, {
        serverName: input.serverName,
        action: result.action,
        content: result.content,
        mode: elicitationMode,
      }, hookCtx)
      if (post.response) return post.response
      if (post.deniedMessage) return { action: 'decline' as const }
      return result
    }
    if (hookCtx) {
      const pre = await applyElicitationHooks(elicitOpts.hooks, {
        serverName: input.serverName,
        message: typeof rawParams.message === 'string' ? rawParams.message : '',
        mode: elicitationMode,
        url: typeof rawParams.url === 'string' ? rawParams.url : undefined,
        requestedSchema: rawParams.requestedSchema as Record<string, unknown> | undefined,
      }, hookCtx)
      if (pre.response) return await finishElicitation(pre.response) as Awaited<ReturnType<McpElicitationHandler>>
      if (pre.deniedMessage) return await finishElicitation({ action: 'decline' as const }) as Awaited<ReturnType<McpElicitationHandler>>
    }
    return await finishElicitation(await resolveElicitationViaUi()) as Awaited<ReturnType<McpElicitationHandler>>

    async function resolveElicitationViaUi(): Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }> {
    const fallback = await defaultElicitationHandler(input)
    if (fallback.action === 'accept') return fallback
    if (!elicitOpts.taskId) return fallback

    const task = await tasks.get(elicitOpts.taskId).catch(() => null)
    if (!task) return fallback

    const inbox = steerInboxes.get(elicitOpts.conversationId) ?? []
    steerInboxes.set(elicitOpts.conversationId, inbox)
    const requestId = `mcp_elicit_${crypto.randomUUID()}`
    const question = input.params.mode === 'url'
      ? [
          `MCP「${input.serverName}」需要你打开或确认一个链接。`,
          input.params.message,
          input.params.url,
        ].filter(Boolean).join('\n')
      : [
          `MCP「${input.serverName}」需要补充一组非敏感信息。`,
          input.params.message,
          '请直接在输入框回复 JSON，例如 {"字段":"值"}；只有一个必填字段时也可以直接回复值。',
          ...mcpSchemaFieldLines(input.params),
        ].filter(Boolean).join('\n')
    const options = input.params.mode === 'url'
      ? [
          { label: '允许', description: '允许 MCP 继续这个链接流程。' },
          { label: '取消', description: '拒绝这次 MCP 请求。' },
        ]
      : [{ label: '取消', description: '不向 MCP 提交信息。' }]
    await tasks.appendEvent(elicitOpts.taskId, {
      type: 'ask_question',
      id: requestId,
      question,
      options,
      allowFreeform: input.params.mode !== 'url',
      placeholder: input.params.mode !== 'url' ? '{"字段":"值"}' : undefined,
      fields: mcpSchemaFields(input.params),
      url: input.params.mode === 'url' ? input.params.url : undefined,
    }).catch(() => undefined)

    const answer = await waitForInboxAnswer(inbox, inbox.length, elicitOpts.signal)
    if (!answer) return { action: 'cancel' as const }
    if (isDeclineAnswer(answer)) return { action: 'decline' as const }
    if (input.params.mode === 'url') return { action: 'accept' as const }

    const content = parseMcpFormAnswer(answer, input.params)
    if (!content) {
      await tasks.appendEvent(elicitOpts.taskId, {
        type: 'context_note',
        text: 'MCP 表单回复没有匹配必填字段，已拒绝这次请求。',
      }).catch(() => undefined)
      return { action: 'decline' as const }
    }
    return { action: 'accept' as const, content }
    }
  }

  async function createTurnStream(rawBody: TurnStreamInput): Promise<{ conversationId: string; stream: AsyncGenerator<SessionEventRecord> }> {
    const rawUserMessage = stringOr(rawBody.message ?? rawBody.userMessage, '') || stringOr(rawBody.messagePreview, '')
    if (!rawUserMessage) throw new TurnSetupError('message required', 400)
    const explicitUserContent = rawBody.userContent?.length ? rawBody.userContent : undefined

    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!

    const conversationId = stringOr(rawBody.conversationId, crypto.randomUUID())
    const workspace = workspaceForActiveWorktree(workspaceFromBody(rawBody), conversationId)
    const steerInbox = steerInboxes.get(conversationId) ?? []
    steerInboxes.set(conversationId, steerInbox)
    const explicitMessagingSocketPath = messagingSocketPathFrom(rawBody, opts.env ?? process.env)
    const messagingSocketPath = explicitMessagingSocketPath || udsPeers.defaultSocketPath(conversationId)
    let udsInbox: UdsInboxServer | undefined
    let udsPeer: UdsPeerRecord | undefined
    let udsInboxWarning = ''
    if (messagingSocketPath) {
      try {
        udsInbox = await startUdsInbox({ socketPath: messagingSocketPath, inbox: steerInbox })
        udsPeer = await udsPeers.register({
          socketPath: udsInbox.socketPath,
          conversationId,
          workspaceRoot: workspace.root,
          explicit: !!explicitMessagingSocketPath,
        })
      } catch (err) {
        udsInboxWarning = `UDS messaging socket failed to start:${err instanceof Error ? err.message : String(err)}`
      }
    }
    const transcript = sessions.transcript(conversationId, workspace.root)
    const touchedMeta = await sessions.touch(conversationId, {
      title: rawUserMessage.slice(0, 40),
      workspaceRoot: workspace.root,
      status: 'running',
    })
    const model = createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)

    // /compact 手动压缩(对齐 cc commands/compact,支持 `/compact 自定义摘要指令`):短路本回合——
    // 真跑一次强制压缩(经 recordCompaction 落盘,压缩前历史留在活跃链可回看),回说明事件,不打模型主循环。
    const compactCommand = rawUserMessage.match(/^\/compact(?:\s+([\s\S]+))?$/)
    if (compactCommand) {
      const compactTranscript = sessions.transcript(conversationId, workspace.root)
      const preMessages = await compactTranscript.load()
      restoreInvokedSkillsFromMessages(preMessages, conversationId)
      const invokedSkillsMsg = createInvokedSkillsMessage(conversationId)
      const out = await compactPipeline({
        messages: preMessages,
        model,
        force: true,
        customInstructions: compactCommand[1]?.trim() || undefined,
        transcriptPath: compactTranscript.path,
        postSummaryMessages: invokedSkillsMsg ? [invokedSkillsMsg] : [],
        readOnlyToolNames: new Set(),
      })
      if (out.didCompact) {
        await compactTranscript.recordCompaction(preMessages, out.messages, {
          trigger: 'manual',
          messagesSummarized: preMessages.length - out.messages.length,
        })
      }
      const noteText = out.didCompact
        ? `已手动压缩上下文:${out.note ?? ''}`.trim()
        : '无需压缩:当前对话还没有可压缩的历史。'
      const stream = (async function* (): AsyncGenerator<SessionEventRecord> {
        yield await sessions.appendEvent(conversationId, { type: 'context_note', text: noteText })
          .catch(() => fallbackEventRecord({ type: 'context_note', text: noteText }))
        const finalEvent = { type: 'final' as const, text: noteText }
        yield await sessions.appendEvent(conversationId, finalEvent).catch(() => fallbackEventRecord(finalEvent))
      })()
      return { conversationId, stream }
    }

    const requestedContextWindowTokens = numberFrom(rawBody.contextWindowTokens ?? rawBody.context_window_tokens, 0)
    const contextWindowTokens = requestedContextWindowTokens > 0
      ? requestedContextWindowTokens
      : getConfiguredOrBuiltInModelContextWindow(providerRuntime.config.model, opts.env ?? process.env)
    // 三层落点(白标目录):bundled(app 内置,managed) + user(~/.billiardbuddy/skills) + workspace(.billiardbuddy/skills,local 信任)。
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const createSkillsRoot = userSkillsRoot()
    const skills = await loadLayeredSkills({ bundledRoot: skillsRoot, workspaceRoot: workspace.root })
    // 领域包启用来源三合一(owner 设计:斜杠命令 /台球 → 主循环注入 pack → 自动找内容 + 跨回合保持):
    //   ① 请求体 enabled_packs(前端专家选择器);② 本回合斜杠入口命令(/台球、/球房、/billiards…→ packIdForCommandName);
    //   ③ 会话已持久化的 enabledPacks(上一回合敲过入口命令,即便这回合前端没回传也保持在模式里)。
    // 必须在 loadCommandsForWorkspace 之前合并——领域包命令(/台球、/billiards:daily-ops)只在 pack 已启用时才加载;
    // 这样斜杠命令本回合就能被识别为命令(注入 prompt)+ 拿到 pack 的 sessionStartContext 知识 + billiards_ops_checklist 工具。
    const entryCommandForPack = rawBody.skipCommandParsing ? null : parseCommandInvocation(rawUserMessage)
    const slashEnabledPackId = entryCommandForPack ? packIdForCommandName(entryCommandForPack.name) : undefined
    const persistedPackIds = Array.isArray(touchedMeta.enabledPacks) ? touchedMeta.enabledPacks : []
    // 挂件按会话:前端 run 消息**总带** enabled_packs 字段(前端 per-conv 真相源,含空=显式关某窗口的台球)。
    //   · 带字段 → 前端为准(不再反向叠加 persisted),支持"关";本回合斜杠 /台球 仍并进来(双保险)。
    //   · 缺字段(定时/后台等非前端路径)→ 沿用持久化 persisted + 斜杠,不掉包也不误清。
    const requestHasPacksField = rawBody.enabled_packs !== undefined || rawBody.enabledPacks !== undefined ||
      rawBody.knowledge_packs !== undefined || rawBody.knowledgePacks !== undefined
    const slashIds = slashEnabledPackId ? [slashEnabledPackId] : []
    const enabledPacks = requestHasPacksField
      ? mergeEnabledPacks(resolveEnabledPacks(rawBody), slashIds)
      : mergeEnabledPacks(resolveEnabledPacks(rawBody), [...persistedPackIds, ...slashIds])
    // 持久化本会话挂件集合(跨重启前端 adopt 兜底恢复):
    //   · 前端带字段 → 以当前集合为准写回(与 persisted 不同才写,支持"关"=写空);
    //   · 缺字段但斜杠新启用 → 补写(老行为)。缺字段且无斜杠 → 完全不动持久化(防误清)。
    const enabledPackIds = enabledPacks.map(pack => pack.id)
    const samePersisted = enabledPackIds.length === persistedPackIds.length && enabledPackIds.every(id => persistedPackIds.includes(id))
    const shouldPersist = requestHasPacksField
      ? !samePersisted
      : Boolean(slashEnabledPackId) && enabledPackIds.some(id => !persistedPackIds.includes(id))
    if (shouldPersist) {
      await sessions.touch(conversationId, { enabledPacks: enabledPackIds }).catch(() => undefined)
    }
    const commands = await loadCommandsForWorkspace(workspace.root, opts.commandsRoot ?? defaultCommandsRoot(), enabledPacks, opts.env ?? process.env)
    // 技能/命令发现清单注入系统提示(对齐 cc SkillTool skill listing):汇总 builtin 命令 + 技能 + 已启用领域包命令,
    // 按约 1% 上下文预算截断,让模型「看清单 → 自动调」,/台球 等斜杠也映射到对应技能/命令。
    const outputStyleLibrary = await loadOutputStyles()
    const outputStyleConfig = resolveOutputStyleConfig(outputStyleLibrary, stringOr(rawBody.output_style ?? rawBody.outputStyle, ''))
    // 会话历史(本回合只 load 一次,给条件技能激活 + 下方 goal hook 共用,避免重复 I/O)。
    const priorMessages = await transcript.load().catch(() => [] as Message[])
    // 条件技能激活(对齐 cc "碰到命中 paths 的文件才现身"):扫会话历史触碰过的文件路径,命中的条件技能并回
    // 本回合发现清单(默认它们被 loadLayeredSkills 排除)。仅当存在条件技能时才算,无则跳过。
    // 回合起点激活:扫历史触碰过的文件,命中的条件技能进本回合发现清单(systemPrompt)。
    // 同轮实时激活由下方 activateConditionalSkillsFn 传进 loop 补上(碰到文件当轮 system-reminder 现身)。
    const hasConditionalSkills = [...skills.byName.values()].some(s => s.paths && s.paths.length > 0)
    let activatedConditionalSkills: PromptCommand[] | undefined
    if (hasConditionalSkills) {
      const touched = collectTouchedFilePaths(priorMessages)
      const activatedNames = activateConditionalSkillsForPaths(skills, workspace.root, touched)
      activatedConditionalSkills = [...activatedNames].map(n => skills.byName.get(n)).filter((s): s is PromptCommand => !!s)
    }
    // 同轮实时激活闭包(对齐 cc 文件工具内联激活):loop 每批工具后拿本批碰到的文件路径调它,命中的条件技能当轮现身。
    // 仅当存在条件技能时提供(否则 undefined,loop 跳过零开销)。
    const activateConditionalSkillsFn = hasConditionalSkills
      ? (paths: string[]): PromptCommand[] => {
          const names = activateConditionalSkillsForPaths(skills, workspace.root, paths)
          return [...names].map(n => skills.byName.get(n)).filter((s): s is PromptCommand => !!s)
        }
      : undefined
    let systemPrompt = await buildSystemPrompt(workspace, { commands, skills, contextWindowTokens, activatedConditionalSkills }, outputStyleConfig)
    // 输出风格已在 buildSystemPrompt 中部注入(对齐 cc systemPromptSection('output_style') + keepCodingInstructions
    // 门控),不再拼到尾部 extraContext。领域包上下文(billiards 等)每回合直接进系统提示——它是"我是谁"的域身份、
    // 每回合都得在,不再骑 SessionStart hook(那会让 SessionStart 每回合重触发,丁审计发现)。
    const domainPackContext = enabledPacks.map(pack => pack.sessionStartContext).filter(Boolean).join('\n\n')
    const extraContext = [
      supportContext(rawBody),
      domainPackContext,
    ].filter(Boolean).join('\n\n')
    if (extraContext) {
      systemPrompt = [systemPrompt, extraContext].filter(Boolean).join('\n\n')
    }
    const bridgeOrigin = rawBody.bridgeOrigin === true || rawBody.bridge_origin === true
    const skipSlashCommands = rawBody.skipSlashCommands === true || rawBody.skip_slash_commands === true
    const parsedCandidate = rawBody.skipCommandParsing ? null : parseCommandInvocation(rawUserMessage)
    const bridgeKnownLocalCommand = bridgeOrigin && parsedCandidate?.name === 'goal'
      ? { type: 'local' as const, name: 'goal' }
      : undefined
    const bridgeMatchedPromptCommand = bridgeOrigin && parsedCandidate && !bridgeKnownLocalCommand ? commands.byName.get(parsedCandidate.name) : undefined
    const bridgeSafeParsedCommand = bridgeOrigin && parsedCandidate
      ? bridgeKnownLocalCommand
          ? isBridgeSafeCommand(bridgeKnownLocalCommand)
          : bridgeMatchedPromptCommand
            ? isBridgeSafeCommand(bridgeMatchedPromptCommand)
            : false
      : false
    const bridgeBlockedCommand = bridgeOrigin && parsedCandidate && (bridgeMatchedPromptCommand || bridgeKnownLocalCommand) && !bridgeSafeParsedCommand
      ? { name: parsedCandidate.name, args: parsedCandidate.args, raw: parsedCandidate.raw }
      : undefined
    const parsedCommand = parsedCandidate && (!skipSlashCommands || bridgeSafeParsedCommand) && !bridgeBlockedCommand
      ? parsedCandidate
      : null
    const goalCommandResult = parsedCommand?.name === 'goal'
      ? await handleGoalCommand(conversationId, parsedCommand.args, transcript)
      : undefined
    const matchedCommand = parsedCommand && !goalCommandResult ? commands.byName.get(parsedCommand.name) : undefined
    const commandInvocation = parsedCommand && matchedCommand
      ? {
          name: matchedCommand.name,
          args: parsedCommand.args,
          raw: parsedCommand.raw,
          source: matchedCommand.source,
          contentLength: matchedCommand.contentLength,
          prompt: await matchedCommand.getPrompt(parsedCommand.args, { workspace }),
        }
      : parsedCommand && goalCommandResult
        ? {
            name: 'goal',
            args: parsedCommand.args,
            raw: parsedCommand.raw,
            source: 'commands' as const,
            contentLength: goalCommandResult.output.length,
            prompt: '',
          }
      : undefined
    // let:UserPromptExpansion hook 的 deny/halt 决策(下方 controller 后派发)可把命令展开体替换成拦截说明,
    // 阻止危险命令原文流入模型(对齐 cc 该事件的拦截语义)。
    let userMessage = goalCommandResult?.shouldQuery
      ? `Continue working until this goal is complete: ${parsedCommand?.args ?? ''}`
      : commandInvocation?.prompt ?? rawUserMessage
    const userContent = commandInvocation || goalCommandResult?.shouldQuery ? undefined : explicitUserContent
    const skillRecommendations = suggestedSkillNamesForPacks(enabledPacks)
    const domainPackTools = createDomainPackTools(enabledPacks)
    // hooks 配置三级加载(user ~/.billiardbuddy/settings.json + 工作区 .billiardbuddy/settings.json +
    // settings.local.json,对齐同仓库 permissions/permissionsSettings.ts 的三级路径;取代已删除的死路径
    // defaultHooksPath()/server/hooks.json)。opts.hooksPath 仍作显式覆盖路径叠加进来(source:'local')。
    const configuredHooks = await loadWorkspaceHookRegistry(workspace.root, opts.hooksPath)
    // 已启用插件贡献的 hooks(对齐 cc loadPluginHooks:标准位置 <plugin>/hooks/hooks.json + manifest.hooks 声明的附加文件),
    // 归一为 source:'plugin' 并入本次会话 hooks(app 级可信、不走工作区信任闸)。坏插件/读失败静默跳过、不拖垮会话。
    const pluginHookPaths = await resolveEnabledPluginHookConfigPaths(defaultPluginRoots(opts.env ?? process.env)).catch(() => [] as string[])
    const pluginHooks = pluginHookPaths.length > 0 ? await loadPluginHookRegistry(pluginHookPaths).catch(() => undefined) : undefined
    // 领域包上下文已改走 systemPrompt(extraContext)每回合注入,不再进 SessionStart hook 注册表——
    // 否则 SessionStart 每回合重触发(丁审计)。此处 hooks 只含用户配置/插件/目标 hook,SessionStart 由 loop 门控成首回合一次。
    // priorMessages 复用上方那次 load(同回合 transcript 不变),不再重复 I/O。
    const hooks = mergeHookRegistries(configuredHooks, pluginHooks, createGoalHookRegistry(conversationId, priorMessages))
    const initialSessionHooks = sessionSkillHooks.get(conversationId)
    const agents = await loadAgentsDir(opts.agentsRoot ?? defaultAgentsRoot())
    const controller = turns.start(conversationId)
    // UserPromptExpansion(官方事件):用户敲的斜杠命令已展开成 prompt → 派发(matcher=命令名);
    // context 决策注入系统提示。命令解析早于 hooks 构建,故派发放这里(hooks 已就绪),对齐 cc 的展开时机。
    // commandExpansionBlocked 提到外层:inline 路径替换 userMessage、fork 路径(下方调度)据它短路,两条路径都拦截。
    let commandExpansionBlocked: string | undefined
    if (commandInvocation && commandInvocation.name !== 'goal') {
      const expansion = await applyUserPromptExpansionHooks(hooks, commandInvocation.name, commandInvocation.prompt, {
        workspace, conversationId, signal: controller.signal,
      })
      if (expansion.additionalContext.length > 0) {
        systemPrompt = `${systemPrompt}\n\n<hook_context event="UserPromptExpansion">\n${expansion.additionalContext.join('\n\n')}\n</hook_context>`
      }
      // deny/halt:拦住命令展开——用拦截说明替换命令体,不让危险原文进模型(对齐 cc UserPromptExpansion 拦截语义)。
      if (expansion.blocked) {
        commandExpansionBlocked = expansion.blocked
        userMessage = `命令 /${commandInvocation.name} 的展开已被 hook 阻止:${expansion.blocked}(命令内容未执行、未注入模型)`
      }
    }
    const gatedMcp = resolveMcpConfig(rawBody, workspace.root)
    const mcpConfigPath = gatedMcp.path
    const mcpTools = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspace.root,
      signal: controller.signal,
      timeoutMs: 10000,
      // toolTimeoutMs 不硬编码:走 mcp/client.ts 的 mcpToolTimeoutMs() 默认值(近乎无限,可用
      // QF_MCP_TOOL_TIMEOUT 覆盖),否则这里的常量会把 P0 修复在生产路径悄悄顶掉。
      fetchImpl: opts.fetchImpl,
      elicitationHandler: input => handleMcpElicitation(input, {
        conversationId,
        taskId: typeof rawBody.taskId === 'string' ? rawBody.taskId : undefined,
        signal: controller.signal,
        hooks,
        workspaceRoot: workspace.root,
      }),
      samplingHandler: ({ params, signal }) => runMcpSampling(model, providerRuntime.config.model, params, signal ?? controller.signal),
      // 主对话=用户在场:OAuth server 首次连接允许拉浏览器交互授权;令牌落 mcpOAuthDir 供各路径复用。
      oauth: { storageDir: mcpOAuthDir, interactive: true },
    })
    // 工作区级 .mcp.json 未信任被拦时,把警告并进 mcp 警告流(由下方 mcpTools.warnings 循环回灌)。
    if (gatedMcp.warning) mcpTools.warnings.unshift(gatedMcp.warning)
    // MCP Server Instructions 注入系统提示(对齐 cc:server 自报使用说明,已 2048 截断/Unicode 净化)。
    if (mcpTools.instructions.length > 0) {
      systemPrompt = [
        systemPrompt,
        '# MCP Server Instructions',
        ...mcpTools.instructions.map(entry => `## ${entry.server}\n${entry.text}`),
      ].join('\n\n')
    }
    const taskTools = [...createTaskTools(tasks), ...createStructuredTaskTools(taskLists)]
    let backgroundAgentOptions: BackgroundAgentTaskOptions | undefined
    const promptWorkerAgent = (prompt: PromptCommand, kind: 'command' | 'skill'): AgentDefinition => {
      const requested = prompt.agent?.trim()
      const found = requested ? agents.find(agent => agent.name === requested) : undefined
      const allowedTools = allowedToolsForAgent(prompt.allowedTools)
      const allowsAllTools = prompt.allowedTools?.includes('*') === true
      if (found) {
        const mergedHooks = mergeHookRegistries(found.hooks, prompt.hooks)
        return {
          ...found,
          ...(allowsAllTools ? { tools: undefined } : allowedTools ? { tools: allowedTools } : {}),
          allowedToolRules: prompt.allowedToolRules ?? prompt.allowedTools,
          ...(mergedHooks ? { hooks: mergedHooks } : {}),
        }
      }
      const suffix = normalizeCommandName(prompt.name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || kind
      return {
        name: `${kind}-${suffix}`,
        description: `Forked ${kind} worker for ${kind === 'command' ? `/${prompt.name}` : prompt.name}.`,
        prompt: [
          `You are running a ${kind} in an isolated worker.`,
          `Execute the ${kind} instructions exactly, using tools when needed.`,
          'Return only the useful result for the parent conversation.',
        ].join('\n'),
        filePath: `built-in:${kind}-fork:${prompt.name}`,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        maxTurns: 80,
        ...(allowedTools ? { tools: allowedTools } : {}),
        allowedToolRules: prompt.allowedToolRules ?? prompt.allowedTools,
        ...(prompt.hooks ? { hooks: prompt.hooks } : {}),
      }
    }
    const executeSkill = async (skill: PromptCommand, args: string, toolCtx: ToolContext): Promise<string> => {
      const expandedPrompt = (await skill.getPrompt(args, toolCtx)).trim()
      recordInvokedSkill(skill, expandedPrompt, toolCtx)
      if (skill.context !== 'fork') {
        allowSkillTools(skill, toolCtx)
        registerSkillHooks(skill, toolCtx)
        return formatUseSkillResult(skill, expandedPrompt)
      }
      if (!backgroundAgentOptions) throw new Error('skill context:fork 需要后台任务运行器')
      if (!expandedPrompt) return `技能 ${skill.name} 没有可执行内容。`
      const agent = promptWorkerAgent(skill, 'skill')
      const { task } = await startBackgroundAgentRun(
        backgroundAgentOptions,
        {
          agent: agent.name,
          task: expandedPrompt,
          title: `skill:${skill.name}${args.trim() ? ` ${args.trim()}` : ''}`.slice(0, 120),
        },
        toolCtx,
        {
          skill: skill.name,
          skill_context: 'fork',
          ...(skill.agent ? { skill_agent: skill.agent } : {}),
        },
        [],
        [],
        { agentOverride: agent },
      )
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      return `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
    }
    const teamTools = createTeamTools(teams, {
      tasks,
      udsPeers,
      bridgePeers,
      sendBridgeMessage: bridgeSendMessageFor(rawBody),
      resumeBackgroundAgent: (task, message, toolCtx) => {
        if (!backgroundAgentOptions) throw new Error('background agent runner is not available')
        return resumeBackgroundAgentTask(backgroundAgentOptions, task, message, toolCtx)
      },
    })
    const mediaTools = createMediaTools(media, { videoEditing })
    const storeDocTools = [createStoreDocsTool(storeDocs)]
    const backgroundBaseRegistry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    const baseRegistry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools] })
    // 子代理 model 解析(对齐 cc getAgentModel):agent frontmatter 的 model 名匹配某个已配置 provider
    // runtime 的模型名时,用该 runtime 单独构造模型;不匹配 → null → agentTool 回退父模型。
    // 白标单模型下 runtimes 通常只有一档,匹配到同名即用、否则回退——机制真接通,owner 配多档即生效。
    const resolveAgentModel = (modelName: string): Model | null => {
      const matched = providerRuntimes.filter(runtime => runtime.config.model === modelName)
      if (matched.length === 0) return null
      return createModelFromRuntimeProviders(matched, opts.fetchImpl, providerHealthCallbacks)
    }
    backgroundAgentOptions = {
      tasks,
      agents,
      model,
      resolveModel: resolveAgentModel,
      baseTools: backgroundBaseRegistry.list(),
      baseSystemPrompt: systemPrompt,
      hooks,
      mcp: {
        mcpConfigPath,
        loadOptions: ({ workspaceRoot, signal, taskId }) => ({
          cwd: workspaceRoot,
          signal,
          timeoutMs: 10000,
          // toolTimeoutMs 不硬编码,同上:走 mcp/client.ts 的近乎无限默认值 + QF_MCP_TOOL_TIMEOUT 覆盖。
          fetchImpl: opts.fetchImpl,
          elicitationHandler: input => handleMcpElicitation(input, {
            conversationId,
            taskId,
            signal,
            hooks,
            workspaceRoot,
          }),
          samplingHandler: ({ params, signal: samplingSignal }) => runMcpSampling(model, providerRuntime.config.model, params, samplingSignal ?? signal ?? controller.signal),
        }),
      },
    }
    const agentSidechainRoot = join(stateRoot, 'agent-task-sidechains')
    const agentTools = agents.length > 0
      ? [createAgentTaskTool({
        agents,
        model,
        resolveModel: resolveAgentModel,
        baseTools: backgroundAgentOptions.baseTools,
        baseSystemPrompt: systemPrompt,
        sidechainRoot: agentSidechainRoot,
        hooks,
        mcp: backgroundAgentOptions.mcp,
        teams,
        startBackgroundAgent: (input, toolCtx, forkContext) => startBackgroundAgentRun(backgroundAgentOptions!, input, toolCtx, {}, [], [], forkContext ? { forkContext } : {}),
        registerForegroundAgent: (input, toolCtx, forkContext) => tasks.registerForegroundAgent({
          agentId: input.agentId,
          agent: input.agent,
          title: input.title,
          conversationId: toolCtx.conversationId,
          workspaceRoot: toolCtx.workspace.root,
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(forkContext ? { params: { fork_context: true } } : {}),
        }),
        handoffForegroundAgent: (registration, input, toolCtx, forkContext) => startBackgroundAgentRun(
          backgroundAgentOptions!,
          input,
          toolCtx,
          { foreground_handoff: true, agent_id: input.agentId },
          [],
          [],
          { ...(forkContext ? { forkContext } : {}), handoffTaskId: registration.task.id },
        ),
        unregisterForegroundAgent: taskId => tasks.unregisterForegroundAgent(taskId),
      })]
      : []
    const agentSidechainTools = agents.length > 0 ? createAgentTaskSidechainTools(agentSidechainRoot) : []
    const backgroundTools = agents.length > 0
      ? [createBackgroundAgentTaskTool(backgroundAgentOptions)]
      : []
    const registry = buildGeneralRegistry({ skills, skillsRoot: createSkillsRoot, skillRecommendations, executeSkill, commands, extraTools: [...domainPackTools, ...mcpTools.tools, ...taskTools, ...teamTools, ...mediaTools, ...storeDocTools, ...agentTools, ...agentSidechainTools, ...backgroundTools] })
    const launchContextForkCommand = async (command: PromptCommand): Promise<string> => {
      const expandedPrompt = commandInvocation?.prompt.trim() ?? ''
      if (!expandedPrompt) return `/${command.name} 没有可执行的命令内容。`
      const parentMessages = await transcript.load()
      const toolCtx = {
        workspace,
        model,
        registry,
        signal: controller.signal,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        conversationId,
        systemPrompt,
        renderedSystemPrompt: systemPrompt,
        toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
      }
      const agent = promptWorkerAgent(command, 'command')
      const args = commandInvocation?.args.trim() ?? ''
      const { task } = await startBackgroundAgentRun(
        backgroundAgentOptions!,
        {
          agent: agent.name,
          task: expandedPrompt,
          title: `/${command.name}${args ? ` ${args}` : ''}`.slice(0, 120),
        },
        toolCtx,
        {
          slash_command: command.name,
          command_context: 'fork',
          ...(command.agent ? { command_agent: command.agent } : {}),
        },
        [],
        [],
        { agentOverride: agent },
      )
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      const output = `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
      await transcript.append([
        ...parentMessages,
        { role: 'user', content: [textBlock(commandInvocation?.raw ?? rawUserMessage)] },
        { role: 'assistant', content: [textBlock(output)] },
      ])
      return output
    }
    const launchBuiltinForkCommand = async (): Promise<string> => {
      const directive = commandInvocation?.args.trim() ?? ''
      if (!directive) return '用法: /fork <directive>'
      const parentMessages = await transcript.load()
      const toolCtx = {
        workspace,
        model,
        registry,
        signal: controller.signal,
        permissionMode: permissionModeFrom(rawBody.permissionMode),
        conversationId,
        messages: parentMessages,
        systemPrompt,
        renderedSystemPrompt: systemPrompt,
        toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
      }
      const forkContext = buildForkRunContext(toolCtx, directive)
      const { task, agent } = await startBackgroundAgentRun(
        backgroundAgentOptions!,
        {
          task: directive,
          title: `fork: ${directive.slice(0, 80)}`,
        },
        toolCtx,
        { slash_command: 'fork' },
        [],
        [],
        { forkContext },
      )
      const name = typeof task.params?.name === 'string' ? ` name="${escapeXml(task.params.name)}"` : ''
      const agentId = typeof task.params?.agent_id === 'string' ? ` agent_id="${escapeXml(task.params.agent_id)}"` : ''
      const output = `<background_task_started id="${escapeXml(task.id)}" agent="${escapeXml(agent.name)}"${name}${agentId} status="${escapeXml(task.status)}">\n${escapeXml(task.title)}\n</background_task_started>`
      await transcript.append([
        ...parentMessages,
        { role: 'user', content: [textBlock(commandInvocation?.raw ?? rawUserMessage)] },
        { role: 'assistant', content: [textBlock(output)] },
      ])
      return output
    }
    const stream = (async function* (): AsyncGenerator<SessionEventRecord> {
      let finalStatus: SessionStatus = 'idle'
      const record = async (event: SessionStreamEvent): Promise<SessionEventRecord> => {
        if (!turns.isCurrent(conversationId, controller)) return fallbackEventRecord(event)
        try {
          return await sessions.appendEvent(conversationId, event)
        } catch {
          return fallbackEventRecord(event)
        }
      }
      try {
        // 用户这句话先进事件日志(回放的唯一真相源):否则切会话/重启后重放只剩 agent 事件,用户气泡消失。
        yield await record({ type: 'user_prompt', text: commandInvocation?.raw ?? rawUserMessage })
        if (bridgeBlockedCommand) {
          const msg = bridgeUnsafeCommandMessage(bridgeBlockedCommand.name)
          yield await record({
            type: 'command_invocation',
            name: bridgeBlockedCommand.name,
            args: bridgeBlockedCommand.args,
            raw: bridgeBlockedCommand.raw,
            source: 'commands',
            contentLength: msg.length,
          })
          yield await record({ type: 'context_note', text: msg })
          yield await record({ type: 'final', text: msg })
          finalStatus = 'idle'
          return
        }
        if (commandInvocation && (commandInvocation.source === 'commands' || commandInvocation.source === 'builtin')) {
          yield await record({
            type: 'command_invocation',
            name: commandInvocation.name,
            args: commandInvocation.args,
            raw: commandInvocation.raw,
            source: 'commands',
            contentLength: commandInvocation.contentLength,
          })
        }
        // UserPromptExpansion deny/halt:fork 命令路径同样拦截——不派后台 fork agent(它会直接拿 commandInvocation.prompt
        // 原始展开体,绕过 inline 路径的 userMessage 替换)。命中即回说明、不执行(对齐 inline 路径的拦截语义)。
        if (commandExpansionBlocked && (isBuiltinForkCommand(commandInvocation) || (commandInvocation && matchedCommand?.context === 'fork'))) {
          yield await record({ type: 'final', text: `命令 /${commandInvocation?.name} 的展开已被 hook 阻止:${commandExpansionBlocked}(命令内容未执行、未派发后台工作代理)` })
          finalStatus = 'idle'
          return
        }
        if (isBuiltinForkCommand(commandInvocation)) {
          const output = await launchBuiltinForkCommand()
          yield await record({ type: 'final', text: output })
          finalStatus = 'idle'
          return
        }
        if (commandInvocation && matchedCommand?.context === 'fork') {
          const output = await launchContextForkCommand(matchedCommand)
          yield await record({ type: 'final', text: output })
          finalStatus = 'idle'
          return
        }
        if (goalCommandResult) {
          yield await record({ type: 'context_note', text: goalCommandResult.output })
          if (!goalCommandResult.shouldQuery) {
            yield await record({ type: 'final', text: goalCommandResult.output })
            finalStatus = 'idle'
            return
          }
        }
        for (const notice of orderedProviderRuntimes.notices) {
          yield await record({ type: 'context_note', text: notice })
        }
        for (const warning of mcpTools.warnings) {
          yield await record({ type: 'context_note', text: warning })
        }
        if (udsInboxWarning) {
          yield await record({ type: 'context_note', text: udsInboxWarning })
        }
        // 加载工作区 .claude/settings.json(+ local)持久化权限规则,置于会话临时规则之前(持久规则打底,会话规则覆盖)。
        const persistedRuleUpdates = permissionUpdatesFromRules(await loadPermissionRules(workspace.root))
        // 白标第二层:用户可见的助手文本(final 全文 + content_delta 流式 + thinking)出口兜底清洗;
        // content_delta 逐 token 流,真名可能跨两个 delta 被切断(如 "Clau"+"de"),故用有状态的
        // carry-over 缓冲(见 createChatOutputScrubber),清完把安全前缀放行、流末 flush 尾巴。
        const outputScrubber = createChatOutputScrubber()
        // max_turns/硬停时 loop 只 yield 事件、不产 final(对齐 cc 由调用方合成最终答复);循环外据此兜底给一条 final。
        let sawFinal = false
        let sawMaxTurns = false
        for await (const rawEvent of runAgentLoop({
          model,
          registry,
          workspace,
          sandbox: buildSandbox(workspace),
          systemPrompt,
          userMessage,
          userContent,
          modelName: providerRuntime.config.model,
          transcript,
          conversationId,
          activateConditionalSkills: activateConditionalSkillsFn,
          initialActivatedSkillNames: activatedConditionalSkills?.map(s => s.name),
          steerInbox,
          registerInterrupt: fn => { interruptRequesters.set(conversationId, fn) },
          signal: controller.signal,
          permissionMode: permissionModeFrom(rawBody.permissionMode),
          initialPermissionUpdates: [...persistedRuleUpdates, ...(sessionPermissionUpdates.get(conversationId) ?? [])],
          initialAllowedTools: commandInvocation && matchedCommand && matchedCommand.context !== 'fork' ? matchedCommand.allowedToolRules ?? matchedCommand.allowedTools : undefined,
          contextWindowChars: typeof rawBody.contextWindowChars === 'number' ? rawBody.contextWindowChars : undefined,
          contextWindowTokens,
          toolResultStoreDir: join(stateRoot, 'tool-results', conversationId),
          stateRoot,
          hooks,
          initialSessionHooks,
          onSessionHooksChanged: updatedHooks => {
            if (updatedHooks && updatedHooks.rules.length > 0) sessionSkillHooks.set(conversationId, updatedHooks)
            else sessionSkillHooks.delete(conversationId)
          },
          teamInbox: { service: teams },
        })) {
          if (rawEvent.type === 'final') sawFinal = true
          else if (rawEvent.type === 'max_turns_reached') sawMaxTurns = true
          // 出口兜底清洗:一个原始事件经清洗器可能变成 0..n 个(final 会先补 flush 打字机尾巴)。
          // content_delta 是瞬时 token 流:实时发给客户端(打字机),但不持久化进事件日志(否则日志膨胀、断线重放会重复整段增量)。
          // final/thinking/context_note 里若被模型自曝真名/供应商/原始报错,一律替成中性口径后再出。
          for (const event of outputScrubber.push(rawEvent)) {
            yield event.type === 'content_delta' ? fallbackEventRecord(event) : await record(event)
          }
        }
        // 流正常结束但没有 final(极少见)时,flush 掉各通道 hold 住的尾巴,别把已收到的正文吞掉。
        for (const event of outputScrubber.flush()) {
          if (event.type === 'final') sawFinal = true
          yield event.type === 'content_delta' ? fallbackEventRecord(event) : await record(event)
        }
        // 循环外兜底"总给最终答复"(对齐 cc:max_turns 命中/纯硬停时 loop 只 yield 事件不产 final,由调用方合成)。
        if (!sawFinal) {
          const aborted = controller.signal.aborted
          if (aborted) finalStatus = 'interrupted'
          const fallbackText = aborted ? '任务已中断' : sawMaxTurns ? '已达最大轮次,未能收敛。' : '任务已结束。'
          yield await record({ type: 'final', text: fallbackText })
        }
      } catch (err) {
        finalStatus = controller.signal.aborted ? 'interrupted' : 'failed'
        // 白标:总失败详情可能带模型层原始报错(真实模型名/供应商/endpoint),出口前统一脱敏。
        const detail = controller.signal.aborted
          ? '任务已中断'
          : scrubProviderIdentifiers(err instanceof Error ? err.message : String(err))
        yield await record({ type: 'context_note', text: `任务执行失败:${detail}` })
        yield await record({ type: 'final', text: `任务执行失败:${detail}` })
      } finally {
        if (udsPeer) await udsPeers.unregister(udsPeer.id).catch(() => undefined)
        await udsInbox?.close().catch(() => undefined)
        await closeMcpConnections(mcpTools.connections)
        const done = await record({ type: 'done' })
        const wasCurrent = turns.finish(conversationId, controller)
        interruptRequesters.delete(conversationId)
        if (wasCurrent) {
          steerInboxes.delete(conversationId)
          await sessions.touch(conversationId, { status: finalStatus })
        }
        yield done
      }
    })()
    return { conversationId, stream }
  }

  async function replayWsEvents(ws: { send(data: string): unknown }, conversationId: string, after: number): Promise<void> {
    const events = await sessions.loadEvents(conversationId, { after, limit: 1000 })
    for (const record of events) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event, replay: true })
  }

  async function handleWsRun(ws: { send(data: string): unknown; data: AgentWsData }, body: Record<string, unknown>): Promise<void> {
    try {
      const { conversationId, stream } = await createTurnStream({ ...body, conversationId: body.conversationId ?? ws.data.conversationId })
      ws.data.conversationId = conversationId
      for await (const record of stream) {
        wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
      }
    } catch (err) {
      wsError(ws, err instanceof Error ? err.message : String(err))
    }
  }

  function legacyEventPayload(taskId: string, conversationId: string | undefined, record: { seq: number; event: SessionStreamEvent | import('../tasks/taskService').TaskStreamEvent }): Record<string, unknown> | null {
    const event = record.event
    const base = { offset: record.seq, task_id: taskId }
    if (event.type === 'started') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'thinking') return { ...base, type: 'reasoning', content: event.text }
    if (event.type === 'command_invocation') return { ...base, type: 'context_note', content: `已展开命令 /${event.name}${event.args ? ` ${event.args}` : ''}` }
    if (event.type === 'tool_call') return { ...base, type: 'tool_call', tool: event.tool, args: event.input }
    if (event.type === 'tool_progress') return { ...base, type: 'tool_progress', tool: event.tool, id: event.id, chunk: event.chunk, stream: event.stream }
    if (event.type === 'tool_result') return { ...base, type: 'tool_result', tool: event.tool, content: event.output }
    if (event.type === 'usage_update') return { ...base, ...event }
    if (event.type === 'ask_question') return { ...base, ...event }
    if (event.type === 'approval_request') return { ...base, ...event, args: event.args }
    if (event.type === 'steering') return { ...base, type: 'steering', content: event.content }
    if (event.type === 'todo_update') return { ...base, type: 'todo_update', content: event.content }
    if (event.type === 'context_note') return { ...base, type: 'context_note', content: event.text }
    if (event.type === 'max_turns_reached') return { ...base, type: 'context_note', content: `已达最大轮次(${event.turnCount}/${event.maxTurns}),已停止继续调用模型。` }
    if (event.type === 'final') return { ...base, type: 'final', content: event.text }
    if (event.type === 'done') return { ...base, type: 'done', stopped_reason: 'stop', conversation_id: conversationId, task_id: taskId, offset: record.seq }
    return null
  }

  async function* legacyTaskEventStream(requestedTaskId: string, after: number): AsyncGenerator<string> {
    let cursor = Math.max(0, after)
    for (let tick = 0; tick < 3000; tick++) {
      const resolved = await resolveTaskEndpointTarget(requestedTaskId)
      const requestedId = resolved.requestedTaskId
      const taskId = resolved.task?.id ?? requestedTaskId
      const task = resolved.task ?? await tasks.get(taskId)
      if (!task) {
        yield legacySseLine({ type: 'error', error: 'task not found', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        yield legacySseLine({ type: 'done', stopped_reason: 'error', task_id: taskId, requested_task_id: requestedId, offset: cursor })
        return
      }
      const events = await tasks.loadEvents(taskId, { after: cursor, limit: 100 })
      for (const record of events) {
        cursor = Math.max(cursor, record.seq)
        const payload = legacyEventPayload(taskId, task.conversationId, record)
        if (payload) {
          yield legacySseLine({
            ...payload,
            ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          })
        }
        if (record.event.type === 'done') return
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        yield legacySseLine({
          type: 'done',
          stopped_reason: task.status === 'failed' ? 'error' : task.status === 'cancelled' ? 'cancelled' : 'stop',
          conversation_id: task.conversationId,
          task_id: taskId,
          ...(requestedId !== taskId ? { requested_task_id: requestedId, resolved_task_id: taskId } : {}),
          ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
          offset: cursor,
        })
        return
      }
      await delay(100)
    }
    yield legacySseLine({ type: 'error', error: 'task event stream timeout', task_id: requestedTaskId, offset: cursor })
  }

  async function startLegacyAgentTask(rawBody: Record<string, unknown>): Promise<{ task_id: string; status: string }> {
    const message = stringOr(rawBody.message, '')
    if (!message) throw new TurnSetupError('message required', 400)
    const workspaceRoot = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
    const conversationId = stringOr(rawBody.conversation_id ?? rawBody.conversationId, crypto.randomUUID())
    const task = await tasks.create({
      title: message.slice(0, 80),
      conversationId,
      workspaceRoot,
    })
    tasks.start(task.id, async taskCtx => {
      let finalText = ''
      const { stream } = await createTurnStream({
        ...rawBody,
        taskId: task.id,
        message,
        conversationId,
        workspaceRoot,
        permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
      })
      for await (const record of stream) {
        if (taskCtx.signal.aborted) break
        if (record.event.type === 'final') finalText = record.event.text
        if (record.event.type === 'user_prompt') continue // 任务通道不透传用户气泡事件(任务参数本就带 prompt)
        await taskCtx.emit(record.event)
      }
      return finalText
    })
    return { task_id: task.id, status: 'running' }
  }

  async function dispatchBridgeInboundToAgent(rawBody: Record<string, unknown>, resolved: BridgeResolvedInboundMessage): Promise<Record<string, unknown>> {
    const conversationId = stringOr(rawBody.conversationId ?? rawBody.conversation_id, '')
    const preview = inboundContentPreview(resolved.content) || 'Bridge inbound message'
    if (!conversationId) return { mode: 'stored' }

    if (turns.isRunning(conversationId)) {
      const inbox = steerInboxes.get(conversationId) ?? []
      inbox.push(preview)
      steerInboxes.set(conversationId, inbox)
      await sessions.appendEvent(conversationId, { type: 'steering', content: preview }).catch(() => undefined)
      return { mode: 'steering', conversationId, queued: inbox.length }
    }

    const autoRun = rawBody.autoRun === true || rawBody.auto_run === true
    if (!autoRun) return { mode: 'stored', conversationId }

    const workspaceRoot = stringOr(rawBody.working_dir ?? rawBody.workspaceRoot, getDefaultWorkspaceDir())
    const task = await tasks.create({
      title: preview.slice(0, 80),
      conversationId,
      workspaceRoot,
      kind: 'bridge_inbound',
      params: {
        bridge_session_id: stringOr(rawBody.bridgeSessionId ?? rawBody.bridge_session_id, ''),
        source: 'bridge_inbound',
        uuid: resolved.uuid,
      },
    })
    tasks.start(task.id, async taskCtx => {
      let finalText = ''
      const { stream } = await createTurnStream({
        ...rawBody,
        taskId: task.id,
        message: preview,
        messagePreview: preview,
        userContent: inboundContentBlocks(resolved.content),
        skipSlashCommands: resolved.skipSlashCommands,
        bridgeOrigin: resolved.bridgeOrigin,
        conversationId,
        workspaceRoot,
        permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
      })
      for await (const record of stream) {
        if (taskCtx.signal.aborted) break
        if (record.event.type === 'final') finalText = record.event.text
        if (record.event.type === 'user_prompt') continue // 任务通道不透传用户气泡事件(任务参数本就带 prompt)
        await taskCtx.emit(record.event)
      }
      return finalText
    })
    return { mode: 'task', conversationId, task_id: task.id, status: 'running' }
  }

  async function archiveSession(id: string, rawBody: Record<string, unknown>) {
    const session = await sessions.get(id)
    if (!session) throw new TurnSetupError('session not found', 404)
    if (session.status === 'running') throw new TurnSetupError('session is running', 409)
    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const providerRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes).runtimes
    const providerRuntime = providerRuntimes[0]!

    const transcript = sessions.transcript(id, session.workspaceRoot)
    const messages = await transcript.load()
    restoreInvokedSkillsFromMessages(messages, id)
    const invokedSkills = createInvokedSkillsMessage(id)
    const keepRecentMessages = Math.max(1, Math.min(100, numberFrom(rawBody.keepRecentMessages ?? rawBody.keep_recent_messages, 12)))
    const minOldMessages = Math.max(1, Math.min(20, numberFrom(rawBody.minOldMessages ?? rawBody.min_old_messages, 1)))
    const model = createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)
    const compacted = await compactPipeline({
      messages,
      model,
      force: true,
      postSummaryMessages: invokedSkills ? [invokedSkills] : [],
      keepRecentMessages,
      minOldMessages,
      readOnlyToolNames: new Set(),
    })
    if (!compacted.didCompact) {
      return { ok: false, archived: false, reason: 'not enough transcript messages to archive', messages: messages.length }
    }

    const archiveDir = join(stateRoot, 'transcript-archives')
    await mkdir(archiveDir, { recursive: true })
    const archivePath = join(archiveDir, `${id}-${Date.now()}.jsonl`)
    await copyFile(transcript.path, archivePath)
    await transcript.save(compacted.messages)
    await sessions.touch(id, { status: 'idle' })
    return {
      ok: true,
      archived: true,
      archivePath,
      beforeMessages: messages.length,
      afterMessages: compacted.messages.length,
      note: compacted.note,
    }
  }

  async function prewarm(rawBody: Record<string, unknown>) {
    const resolvedProviderRuntimes = await providers.resolveRuntimeConfigs(opts.env ?? process.env)
    if (resolvedProviderRuntimes.length === 0) throw new TurnSetupError('model provider not configured', 503)
    const orderedProviderRuntimes = orderRuntimeProvidersForAttempt(resolvedProviderRuntimes)
    const providerRuntimes = orderedProviderRuntimes.runtimes
    const providerRuntime = providerRuntimes[0]!
    createModelFromRuntimeProviders(providerRuntimes, opts.fetchImpl, providerHealthCallbacks)

    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const agentsRoot = opts.agentsRoot ?? defaultAgentsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const [skills, commands, hooks, agents] = await Promise.all([
      loadLayeredSkills({ bundledRoot: skillsRoot, workspaceRoot: workspace.root }),
      loadCommandsForWorkspace(workspace.root, commandsRoot, enabledPacks, opts.env ?? process.env),
      // hooks 三级加载(见上方 §1621 同款注释);opts.hooksPath 仍作显式覆盖路径叠加。
      loadWorkspaceHookRegistry(workspace.root, opts.hooksPath),
      loadAgentsDir(agentsRoot),
    ])

    const includeMcp = rawBody.includeMcp === true || rawBody.includeMcp === 'true'
    let mcp: { tools: number; warnings: string[] } | undefined
    if (includeMcp) {
      const mcpConfigPath = resolveMcpConfig(rawBody, workspace.root).path
      const loaded = await loadMcpToolsFromFile(mcpConfigPath, {
        cwd: workspace.root,
        timeoutMs: 5000,
        fetchImpl: opts.fetchImpl,
        oauth: { storageDir: mcpOAuthDir, interactive: false }, // 探测只数工具数,不触发授权弹窗
      })
      mcp = { tools: loaded.tools.length, warnings: loaded.warnings }
      await closeMcpConnections(loaded.connections)
    }

    const conversationId = typeof rawBody.conversationId === 'string' && rawBody.conversationId.trim() ? rawBody.conversationId.trim() : undefined
    if (conversationId) {
      await sessions.touch(conversationId, {
        workspaceRoot: workspace.root,
        status: 'idle',
      })
    }

    return {
      ok: true,
      provider: {
        source: providerRuntime.source,
        providerId: providerRuntime.providerId,
        providerName: providerRuntime.providerName,
        // 白标:出口摘要走 publicProviderSummary(删 baseUrl/model/apiFormat)。
        summary: publicProviderSummary(providerRuntime.config),
      },
      fallbackCount: Math.max(0, resolvedProviderRuntimes.length - 1),
      ...(orderedProviderRuntimes.notices.length ? { notices: orderedProviderRuntimes.notices } : {}),
      workspaceRoot: workspace.root,
      skills: { root: skillsRoot, count: skills.skills.length },
      commands: { root: commandsRoot, count: commands.commands.length },
      domainTools: { count: createDomainPackTools(enabledPacks).length },
      hooks: { path: opts.hooksPath, count: hooks?.rules.length ?? 0 },
      agents: { root: agentsRoot, count: agents.length },
      ...(mcp ? { mcp } : {}),
    }
  }

  function bridgeSendMessageFor(rawBody: Record<string, unknown>) {
    const config = bridgeRemoteConfigFromBody(rawBody, opts.env ?? process.env)
    if (!config) return undefined
    const transport = createBridgeRemoteTransport({ ...config, fetchImpl: opts.fetchImpl })
    return async (sessionId: string, message: string) => {
      const result = await transport.sendUserMessage(sessionId, message)
      return {
        ok: result.ok,
        error: result.error ?? (result.status ? `Remote Control event POST failed ${result.status}` : undefined),
      }
    }
  }

  async function buildExecutionRegistry(rawBody: Record<string, unknown>) {
    const workspace = workspaceFromBody(rawBody)
    const skillsRoot = opts.skillsRoot ?? defaultSkillsRoot()
    const commandsRoot = opts.commandsRoot ?? defaultCommandsRoot()
    const enabledPacks = resolveEnabledPacks(rawBody)
    const domainPackTools = createDomainPackTools(enabledPacks)
    // plugin 运行时接入:已启用插件的 skills/.mcp.json 并入本次会话(插件是 app 级可信来源,mcp 直接加载不走工作区信任闸)。
    const pluginContribs = await resolveEnabledPluginContributions(defaultPluginRoots(opts.env ?? process.env)).catch(() => ({ skillsDirs: [], commandsDirs: [], mcpConfigPaths: [] }))
    const [skills, commands, pluginSkillsLibs, pluginCommandLibs] = await Promise.all([
      loadLayeredSkills({ bundledRoot: skillsRoot, workspaceRoot: workspace.root }),
      loadCommandsForWorkspace(workspace.root, commandsRoot, enabledPacks, opts.env ?? process.env),
      Promise.all(pluginContribs.skillsDirs.map(dir => loadSkillsDir(dir).catch(() => null))),
      Promise.all(pluginContribs.commandsDirs.map(dir => loadCommandsDir(dir).catch(() => null))),
    ])
    // 合并主 skills + 插件 skills(按名去重,主 skills 优先)
    const mergedSkillByName = new Map(skills.byName)
    for (const lib of pluginSkillsLibs) {
      if (!lib) continue
      for (const s of lib.skills) if (!mergedSkillByName.has(s.name)) mergedSkillByName.set(s.name, s)
    }
    const allSkills = { skills: [...mergedSkillByName.values()], byName: mergedSkillByName }
    // 合并主 commands + 插件 commands(对齐 cc getPluginCommands 并入命令来源):主 commands 放最后 → 同名主/工作区/领域包优先,插件只补充新命令。
    const mergedCommands = mergeCommandLibraries(
      ...pluginCommandLibs.filter((lib): lib is CommandLibrary => lib !== null),
      commands,
    )
    const mcpConfigPath = resolveMcpConfig(rawBody, workspace.root).path
    // toolTimeoutMs 不硬编码:走 mcp/client.ts 的近乎无限默认值 + QF_MCP_TOOL_TIMEOUT 覆盖。
    const mcpLoadOpts = { cwd: workspace.root, timeoutMs: 10000, fetchImpl: opts.fetchImpl, oauth: { storageDir: mcpOAuthDir, interactive: false } }
    const [mcpTools, ...pluginMcpResults] = await Promise.all([
      loadMcpToolsFromFile(mcpConfigPath, mcpLoadOpts),
      ...pluginContribs.mcpConfigPaths.map(path => loadMcpToolsFromFile(path, mcpLoadOpts).catch(() => ({ tools: [], connections: [], warnings: [] }))),
    ])
    const allMcpTools = [...mcpTools.tools, ...pluginMcpResults.flatMap(r => r.tools)]
    const allConnections = [...mcpTools.connections, ...pluginMcpResults.flatMap(r => r.connections)]
    const registry = buildGeneralRegistry({
      skills: allSkills,
      skillsRoot: userSkillsRoot(),
      skillRecommendations: suggestedSkillNamesForPacks(enabledPacks),
      commands: mergedCommands,
      extraTools: [...domainPackTools, ...allMcpTools, ...createTaskTools(tasks), ...createStructuredTaskTools(taskLists), ...createTeamTools(teams, { tasks, udsPeers, bridgePeers, sendBridgeMessage: bridgeSendMessageFor(rawBody) }), ...createMediaTools(media, { videoEditing }), createStoreDocsTool(storeDocs)],
    })
    return { workspace, registry, connections: allConnections }
  }

  /** 审批放行执行的核心:POST /agent/execute 与 WS {type:'approve'} 共用。返回结果 payload 或 null(参数缺失)。 */
  async function runApprovedTool(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return null
    const tool = body.tool.trim()
    const args = body.args ?? {}
    const approvalArgs = isRecord(body.approval_args) ? body.approval_args : isRecord(body.approvalArgs) ? body.approvalArgs : args
    const token = typeof body.token === 'string' ? body.token : undefined
    const conversationId = stringOr(body.conversation_id ?? body.conversationId, '')
    // 审批续跑必须回到原会话的上下文:请求没带 working_dir / enabled_packs 时从 session meta 补齐(自愈)。
    // 不补 working_dir → workspaceFromBody 兜底默认目录,文件写错文件夹、transcript 劈错分区(2026-07-12 真机逮到)。
    // 不补 enabled_packs → buildExecutionRegistry 只读 rawBody,审批放行的执行拿不到会话已挂的领域包工具/命令
    //(与主回合 §1565 三源合并口径不一致;当前领域包工具都未 requiresApproval 故暂不可触发,但结构上是同类分叉,一并收口)。
    if (conversationId) {
      const missingWd = !stringOr(body.working_dir ?? body.workspaceRoot, '')
      const missingPacks = resolveEnabledPacks(body).length === 0
      if (missingWd || missingPacks) {
        const meta = await sessions.get(conversationId).catch(() => undefined)
        if (meta) {
          if (missingWd && meta.workspaceRoot) body = { ...body, working_dir: meta.workspaceRoot }
          if (missingPacks && Array.isArray(meta.enabledPacks) && meta.enabledPacks.length) body = { ...body, enabled_packs: meta.enabledPacks }
        }
      }
    }
    const built = await buildExecutionRegistry(body)
    try {
      const baseCtx: ToolContext = {
        workspace: built.workspace,
        sandbox: buildSandbox(built.workspace),
        registry: built.registry,
        conversationId: conversationId || undefined,
        permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
        toolResultStoreDir: conversationId ? join(stateRoot, 'tool-results', conversationId) : undefined,
        stateRoot,
      }
      // 持久化权限规则(工作区 .claude/settings.json)打底 + 会话临时规则覆盖,审批放行执行也认持久规则。
      const persistedRuleUpdates = permissionUpdatesFromRules(await loadPermissionRules(built.workspace.root))
      const ctx = applyPermissionUpdates(baseCtx, [...persistedRuleUpdates, ...(conversationId ? sessionPermissionUpdates.get(conversationId) ?? [] : [])])
      const result = await executeApproved(built.registry, tool, args, token, ctx, body.remember_approval === true || body.rememberApproval === true, approvalArgs)
      if (conversationId && result.ok && result.permissionUpdates?.length) {
        const existing = sessionPermissionUpdates.get(conversationId) ?? []
        sessionPermissionUpdates.set(conversationId, dedupePermissionUpdates([...existing, ...result.permissionUpdates]))
      }
      // cc 对齐:批准后把执行结果落进 transcript,让下一轮模型看得见"审批放行的工具结果",而不是永远停在 pending。
      // 审批在回合结束后发生(loop 在 approval_request 处已 return),无并发写,load+save 追加安全。
      if (conversationId && result.ok) {
        const transcriptStore = sessions.transcript(conversationId, built.workspace.root)
        const existing = await transcriptStore.load().catch(() => [] as Message[])
        const approvedMessage: Message = { role: 'user', content: [textBlock(`[已批准并执行工具 ${tool}]\n${result.output}`)] }
        await transcriptStore.append([...existing, approvedMessage]).catch(() => undefined)
      }
      return {
        tool,
        result: result.output,
        ok: result.ok,
        ...(result.permissionUpdates?.length ? { permission_updates: result.permissionUpdates } : {}),
        continuation: '',
        approval: null,
      }
    } finally {
      await closeMcpConnections(built.connections)
    }
  }

  async function executeLegacyAgentTool(body: Record<string, unknown>) {
    const payload = await runApprovedTool(body)
    if (!payload) return jsonDetailError('tool required', 400)
    return Response.json(payload)
  }

  async function rejectLegacyAgentTool(body: Record<string, unknown>) {
    if (typeof body.tool !== 'string' || !body.tool.trim()) return jsonDetailError('tool required', 400)
    const workspace = workspaceFromBody(body)
    handleReject(body.tool.trim(), body.args ?? {}, {
      workspace,
      conversationId: stringOr(body.conversation_id ?? body.conversationId, '') || undefined,
      permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
    })
    return Response.json({ ok: true })
  }

  function dedupePermissionUpdates(updates: PermissionUpdate[]): PermissionUpdate[] {
    const seen = new Set<string>()
    const out: PermissionUpdate[] = []
    for (const update of updates) {
      const key = JSON.stringify(update)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(update)
    }
    return out
  }

  async function legacyConversations() {
    const deleted = await legacyStore.deletedConversationIds()
    const rows = await sessions.list()
    return {
      conversations: rows
        .filter(session => !deleted.has(session.id))
        .map(session => ({
          conversation_id: session.id,
          title: session.title || '新对话',
          last_at: session.updatedAt,
        })),
    }
  }

  async function legacyConversationMessages(id: string) {
    const session = await sessions.get(id).catch(() => null)
    if (!session) return { conversation_id: id, messages: [] }
    const messages = await sessions.loadTranscript(id)
    return {
      conversation_id: id,
      messages: messages
        .map(message => ({ role: message.role, content: messageText(message) }))
        .filter(message => message.content),
    }
  }

  async function deletedConversationArtifacts(limit: number): Promise<LegacyArtifact[]> {
    const deleted = await legacyStore.listDeletedConversations()
    const out: LegacyArtifact[] = []
    for (const record of deleted) {
      const session = await sessions.get(record.id).catch(() => null)
      out.push({
        id: record.id,
        kind: 'task',
        type: 'agent_conversation',
        title: session?.title || '已删除会话',
        subtitle: 'AI 对话',
        content: null,
        url: null,
        conversation_id: record.id,
        created_at: record.deleted_at,
      })
      if (out.length >= limit) break
    }
    return out
  }

  async function fileDiffFromQuery(url: URL): Promise<Response> {
    const requested = url.searchParams.get('path') || ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    const target = resolve(requested)
    if (isSensitiveFilePath(target)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const backupParam = url.searchParams.get('backup_path') || url.searchParams.get('backupPath') || ''
    const backup = backupParam ? resolve(backupParam) : ''
    if (backup && isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '备份文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    const [oldText, newText] = await Promise.all([
      backup ? readTextIfExists(backup) : Promise.resolve(''),
      readTextIfExists(target),
    ])
    return Response.json({ ok: true, path: target, backup_path: backup || null, old: oldText, new: newText })
  }

  async function restoreFileFromBackup(body: Record<string, unknown>): Promise<Response> {
    const requested = typeof body.path === 'string' ? body.path : ''
    const backupRequested = typeof body.backup_path === 'string'
      ? body.backup_path
      : typeof body.backupPath === 'string'
        ? body.backupPath
        : ''
    if (!requested.trim()) return Response.json({ ok: false, error: 'path required' }, { status: 400 })
    if (!backupRequested.trim()) return Response.json({ ok: false, error: 'backup_path required' }, { status: 400 })
    const target = resolve(requested)
    const backup = resolve(backupRequested)
    if (isSensitiveFilePath(target) || isSensitiveFilePath(backup)) {
      return Response.json({ ok: false, error: '该文件可能含敏感信息，需要在对话中经确认后处理。' })
    }
    if (!existsSync(backup)) return Response.json({ ok: false, path: target, backup_path: backup, error: '备份文件不存在' })
    const currentBackupPath = join(dirname(target), '.restore-backups', `${basename(target)}.${Date.now()}.bak`)
    await mkdir(dirname(currentBackupPath), { recursive: true })
    if (existsSync(target)) await copyFile(target, currentBackupPath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(backup, target)
    return Response.json({ ok: true, path: target, backup_path: backup, current_backup_path: existsSync(currentBackupPath) ? currentBackupPath : undefined })
  }

  async function legacyChatResponse(rawBody: Record<string, unknown>): Promise<Response> {
    const { conversationId, stream } = await createTurnStream({
      ...rawBody,
      conversationId: rawBody.conversation_id ?? rawBody.conversationId,
      permissionMode: rawBody.permission_mode ?? rawBody.permissionMode,
    })
    const bodyStream = (async function* () {
      for await (const record of stream) {
        const payload = legacyEventPayload(conversationId, conversationId, record)
        if (payload) yield legacySseLine(payload)
      }
    })()
    return new Response(bodyStream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  function dailyDraftPayload() {
    return {
      drafts: [
        {
          title: '今晚黄金档朋友圈',
          category: 'content',
          prompt_key: 'billiards_evening_peak',
          content: '今晚桌台状态在线，适合约一局放松一下。到店可问前台拿今日空桌安排，三五好友开台更划算。',
        },
        {
          title: '新客体验短文案',
          category: 'content',
          prompt_key: 'billiards_new_guest',
          content: '第一次来不用担心不会打，店里可以帮你安排合适桌型和基础指引。想练球、聚会、放松都可以直接来。',
        },
        {
          title: '助教课转化文案',
          category: 'content',
          prompt_key: 'billiards_coach',
          content: '想把准度和走位练稳定，可以约一节助教体验。先看动作问题，再给你一套能自己练的短计划。',
        },
      ],
      cached: false,
    }
  }

  async function saveUpload(req: Request, kind: 'logo' | 'qrcode') {
    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return jsonDetailError('file required', 400)
    const ext = extname(file.name || '') || '.bin'
    const rel = `/uploads/local/${kind}-${Date.now()}${ext}`
    const abs = join(stateRoot, 'uploads', 'local', basename(rel))
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, Buffer.from(await file.arrayBuffer()))
    const qrcodeContent = kind === 'qrcode' ? optionalString(form?.get('content')) : null
    const extra = qrcodeContent ? { qrcode_text: qrcodeContent } : {}
    await desktopData.updateStore({ [`${kind}_url`]: rel, ...extra })
    return Response.json({ url: rel })
  }

  async function serveLocalUpload(pathname: string): Promise<Response | null> {
    if (!pathname.startsWith('/uploads/local/')) return null
    const abs = join(stateRoot, 'uploads', 'local', basename(pathname))
    if (!existsSync(abs)) return null
    return new Response(await readFile(abs))
  }

  interface StudioBrandAsset {
    role: 'logo' | 'qrcode' | 'brand'
    url: string
  }

  function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const value of values) {
      const trimmed = value.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
    return out
  }

  function existingUploadUrl(value: unknown): string | null {
    const raw = optionalString(value)
    if (!raw || !raw.startsWith('/uploads/')) return null
    if (raw.includes('\0')) return null
    const rel = raw.slice('/uploads/'.length)
    if (!rel || rel.split(/[\\/]/).some(segment => segment === '..')) return null
    const uploadsRoot = resolve(stateRoot, 'uploads')
    const abs = resolve(uploadsRoot, rel)
    if (abs !== uploadsRoot && !abs.startsWith(`${uploadsRoot}/`) && !abs.startsWith(`${uploadsRoot}\\`)) return null
    return existsSync(abs) ? raw : null
  }

  function brandStyleText(value: unknown): string | undefined {
    const raw = optionalString(value)
    if (!raw) return undefined
    const labels: Record<string, string> = {
      lively: '热闹活力',
      professional: '专业可信',
      youthful: '年轻潮流',
      premium: '高端质感',
      minimal: '简约干净',
      luxury: '高档大气',
      sporty: '活力运动',
    }
    return labels[raw] ? `${labels[raw]}(${raw})` : raw
  }

  function storeBrandAssets(store: Record<string, unknown>): StudioBrandAsset[] {
    const assets: StudioBrandAsset[] = []
    const logo = existingUploadUrl(store.logo_url)
    const qrcode = existingUploadUrl(store.qrcode_url)
    if (logo) assets.push({ role: 'logo', url: logo })
    if (qrcode) assets.push({ role: 'qrcode', url: qrcode })
    for (const url of stringArray(store.brand_reference_images).map(existingUploadUrl).filter((item): item is string => !!item).slice(0, 4)) {
      assets.push({ role: 'brand', url })
    }
    return assets
  }

  function storeBrandSuffix(store: Record<string, unknown>, assets: StudioBrandAsset[], body: Record<string, unknown>, mode: 'generate' | 'edit'): string {
    const lines: string[] = []
    const explicitStoreInfo = body.add_store_info === true
    const storeName = optionalString(store.name)
    const city = optionalString(store.city)
    const district = optionalString(store.district)
    const location = [city, district].filter(Boolean).join('')
    const brandStyle = brandStyleText(store.brand_style ?? store.style)
    const brandColor = optionalString(store.brand_color)
    const hasCustomName = !!storeName && storeName !== '我的台球房'
    const hasLogo = assets.some(asset => asset.role === 'logo')
    const hasQrAsset = assets.some(asset => asset.role === 'qrcode')
    const hasQrContent = !!optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const hasQr = hasQrAsset || hasQrContent
    const hasBrandRefs = assets.some(asset => asset.role === 'brand')
    const hasContext = explicitStoreInfo || hasCustomName || !!location || !!brandStyle || !!brandColor || assets.length > 0
    if (!hasContext) return ''

    if ((explicitStoreInfo || hasCustomName) && storeName) lines.push(`门店名称:${storeName}`)
    if (location) lines.push(`门店位置:${location}`)
    if (brandStyle) lines.push(`品牌风格:${brandStyle}`)
    if (brandColor) lines.push(`品牌主色调呼应 ${brandColor}，背景和点缀色协调即可，不要求整图都是这个颜色。`)
    if (hasLogo) lines.push('已附带门店 Logo 作为输入图，可自然融入画面或留出安全位置；不要扭曲、改字或把它当成装饰纹理。')
    if (hasQr) {
      const printNote = body.print_mode === true
        ? '这张图用于印刷/线下投放，二维码必须保持方正、清晰、可扫描，并留出足够静区。'
        : '二维码可作为行动入口自然出现，但必须保持方正、清晰、可扫描，不要重绘成花纹。'
      lines.push(`已附带门店二维码作为输入图，${printNote}`)
    }
    if (hasBrandRefs) lines.push('已附带品牌参考图，只提取品牌质感和配色，不要照搬无关内容。')
    if (mode === 'edit' && assets.length > 0) {
      lines.push('改图时第一张输入图是需要保留血缘的源图，门店素材只作为品牌融合参考。')
    } else if (assets.length > 0) {
      lines.push('输入素材用于品牌约束和版式参考，不要让参考图里的无关背景抢占主画面。')
    }
    return lines.length ? `门店品牌约束:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : ''
  }

  async function prepareStudioImageBody(rawBody: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    const store: Record<string, unknown> = await desktopData.getStore().catch(() => ({}))
    const assets = storeBrandAssets(store)
    const brandReferencePaths = assets.map(asset => asset.url)
    const logoAsset = assets.find(asset => asset.role === 'logo')
    const qrcodeAsset = assets.find(asset => asset.role === 'qrcode')
    const qrcodeText = optionalString(store.qrcode_text ?? store.qrcode_content ?? store.qr_content)
    const referenceImagePaths = uniqueStrings([...stringArray(rawBody.reference_image_paths), ...brandReferencePaths]).slice(0, 14)
    const suffix = storeBrandSuffix(store, assets, rawBody, mode)
    const body: Record<string, unknown> = {
      ...rawBody,
      _store_brand_pack_applied: true,
    }
    delete body._system_brand_context
    if (referenceImagePaths.length > 0) body.reference_image_paths = referenceImagePaths
    if (logoAsset && !body._print_logo_path) body._print_logo_path = logoAsset.url
    if (qrcodeAsset && !body._print_qr_path) body._print_qr_path = qrcodeAsset.url
    if (qrcodeText && !body._print_qr_content) body._print_qr_content = qrcodeText
    if (suffix) body._system_brand_context = suffix
    return body
  }

  async function handleCanvasRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/canvas/')) return null
    const action = url.pathname.slice('/api/v1/canvas/'.length)
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    if (action === 'edit' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const instruction = typeof body.instruction === 'string' ? body.instruction : ''
      return Response.json({ content: instruction ? `${content}\n\n${instruction}`.trim() : content, mode: 'local_fallback' })
    }
    if (action === 'render' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format.toLowerCase() : 'txt'
      const rendered = renderDeliverableBytes(content, format)
      return Response.json({ base64: Buffer.from(rendered.bytes).toString('base64'), ext: rendered.ext })
    }
    if (action === 'save-to-library' && req.method === 'POST') {
      const content = typeof body.content === 'string' ? body.content : ''
      const format = typeof body.format === 'string' ? body.format : 'txt'
      const rawName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `artifact-${Date.now()}`
      const safeName = rawName.replace(/[\\/:*?"<>|]+/g, '_')
      const rendered = renderDeliverableBytes(content, format)
      const ext = rendered.ext
      const abs = join(stateRoot, 'library', `${safeName}.${ext}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, rendered.bytes)
      return Response.json({ ok: true, path: abs })
    }
    if (action === 'doc' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), render: text.length > 200_000 ? 'toobig' : 'page', html: `<pre>${escapeHtml(text)}</pre>`, truncated: false })
    }
    if (action === 'sheet' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && isXlsxPath(resolve(path))) {
        try {
          return Response.json(await readXlsxSheet(resolve(path), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      const rows = text.split(/\r?\n/).slice(0, 200).map(line => line.split(','))
      return Response.json({ name: basename(path || 'sheet.csv'), sheets: [{ name: 'Sheet1', rows }], truncated: false })
    }
    if (action === 'excel-edit' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      if (path && isTextSheetPath(path)) {
        return Response.json(await editCsvCell(path, String(body.cell ?? ''), String(body.value ?? '')))
      }
      if (path && isXlsxPath(path)) {
        try {
          return Response.json(await editXlsxCell(path, String(body.cell ?? ''), String(body.value ?? ''), typeof body.sheet === 'string' ? body.sheet : undefined))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, sheet: 'Sheet1', cell: String(body.cell ?? ''), old: '', new: String(body.value ?? ''), detail: 'TS 本地模式仅支持 csv/xlsx 表格写回' }, { status: 501 })
    }
    if (action === 'doc-blocks' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? body.path : ''
      if (path && (isDocxPath(resolve(path)) || isPptxPath(resolve(path)))) {
        try {
          return Response.json(await readOfficeDocumentBlocks(resolve(path)))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      const text = path ? await readTextIfExists(resolve(path)) : ''
      return Response.json({ name: basename(path || 'document.txt'), kind: 'docx', blocks: text.split(/\n{2,}/).slice(0, 200).map((block, i) => ({ id: `b${i}`, kind: 'paragraph', text: block })) })
    }
    if (action === 'doc-save' && req.method === 'POST') {
      const path = typeof body.path === 'string' ? resolve(body.path) : ''
      const edits = body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits)
        ? body.edits as Record<string, unknown>
        : {}
      if (path && isTextDocumentPath(path)) {
        return Response.json(await saveTextDocumentBlocks(path, edits))
      }
      if (path && (isDocxPath(path) || isPptxPath(path))) {
        try {
          return Response.json(await saveOfficeDocumentBlocks(path, edits))
        } catch (err) {
          return canvasOfficeError(err)
        }
      }
      return Response.json({ ok: false, path: String(body.path ?? ''), saved: 0, detail: 'TS 本地模式仅支持 txt/md/html/docx/pptx 文档写回' }, { status: 501 })
    }
    return null
  }

  function canvasOfficeError(error: unknown): Response {
    if (error instanceof OfficeDocumentError) return jsonDetailError(error.message, error.status)
    return jsonDetailError(error instanceof Error ? error.message : String(error), 500)
  }

  function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  function escapeXml(value: string): string {
    return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  }

  function renderDeliverableBytes(content: string, format: string): { bytes: Uint8Array; ext: string } {
    const fmt = format.toLowerCase()
    if (fmt.includes('docx') || fmt.includes('word')) return { bytes: renderMinimalDocx(content), ext: 'docx' }
    if (fmt.includes('pptx') || fmt.includes('powerpoint') || fmt.includes('幻灯片')) return { bytes: renderMinimalPptx(content), ext: 'pptx' }
    if (fmt.includes('xlsx') || fmt.includes('excel') || fmt.includes('表格')) return { bytes: renderMinimalXlsx(content), ext: 'xlsx' }
    if (fmt.includes('html') || fmt.includes('网页')) return { bytes: Buffer.from(renderMarkdownHtml(content), 'utf8'), ext: 'html' }
    if (fmt.includes('md') || fmt.includes('markdown')) return { bytes: Buffer.from(content, 'utf8'), ext: 'md' }
    return { bytes: Buffer.from(stripMarkdown(content), 'utf8'), ext: 'txt' }
  }

  function stripMarkdown(content: string): string {
    return content
      .split('\n')
      .map(line => line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^\s*[-*]\s+/, '- ')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1'))
      .join('\n')
  }

  function renderMarkdownHtml(content: string): string {
    const body: string[] = []
    let inList = false
    for (const raw of content.split('\n')) {
      const line = raw.trimEnd()
      const heading = line.match(/^(#{1,6})\s+(.*)$/)
      const bullet = line.match(/^\s*[-*]\s+(.*)$/)
      if (!bullet && inList) {
        body.push('</ul>')
        inList = false
      }
      if (heading) {
        const level = heading[1]!.length
        body.push(`<h${level}>${inlineMarkdownHtml(heading[2]!)}</h${level}>`)
      } else if (bullet) {
        if (!inList) {
          body.push('<ul>')
          inList = true
        }
        body.push(`<li>${inlineMarkdownHtml(bullet[1]!)}</li>`)
      } else if (line.trim()) {
        body.push(`<p>${inlineMarkdownHtml(line)}</p>`)
      }
    }
    if (inList) body.push('</ul>')
    return [
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<style>body{font-family:-apple-system,system-ui,'PingFang SC',sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.75;color:#1d1d1f;}h1{font-size:24px;}h2{font-size:20px;}h3{font-size:17px;}</style>",
      '</head><body>',
      body.join('\n'),
      '</body></html>',
    ].join('')
  }

  function inlineMarkdownHtml(value: string): string {
    return escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
  }

  function renderMinimalDocx(content: string): Uint8Array {
    const paragraphs = content.split(/\n+/).map(line => line.trim()).filter(Boolean)
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      paragraphs.map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(stripMarkdown(line))}</w:t></w:r></w:p>`).join('') +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
    return zipStore([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8') },
      { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8') },
      { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
    ])
  }

  async function backupLocalFile(path: string): Promise<string | null> {
    if (!existsSync(path)) return null
    const bdir = join(dirname(path), '.billiards-backups')
    await mkdir(bdir, { recursive: true })
    const backup = join(bdir, `${basename(path)}.${Date.now()}.bak`)
    await copyFile(path, backup)
    return backup
  }

  function isTextDocumentPath(path: string): boolean {
    if (isSensitiveFilePath(path)) return false
    return ['.txt', '.md', '.markdown', '.html', '.htm'].includes(extname(path).toLowerCase())
  }

  function isTextSheetPath(path: string): boolean {
    if (isSensitiveFilePath(path)) return false
    return extname(path).toLowerCase() === '.csv'
  }

  async function saveTextDocumentBlocks(path: string, edits: Record<string, unknown>) {
    const text = await readTextIfExists(path)
    const blocks = text.split(/\n{2,}/)
    let saved = 0
    for (const [id, value] of Object.entries(edits)) {
      const match = id.match(/^b(\d+)$/)
      if (!match || typeof value !== 'string') continue
      const index = Number(match[1])
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) continue
      blocks[index] = value
      saved++
    }
    if (saved > 0) {
      await backupLocalFile(path)
      await writeFile(path, blocks.join('\n\n'), 'utf8')
    }
    return { ok: true, path, saved }
  }

  function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
    const localParts: Buffer[] = []
    const centralParts: Buffer[] = []
    let offset = 0
    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8')
      const data = Buffer.from(file.data)
      const crc = crc32(data)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt16LE(0, 10)
      local.writeUInt16LE(0, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      localParts.push(local, name, data)

      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0, 8)
      central.writeUInt16LE(0, 10)
      central.writeUInt16LE(0, 12)
      central.writeUInt16LE(0, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(data.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(name.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(0, 38)
      central.writeUInt32LE(offset, 42)
      centralParts.push(central, name)
      offset += local.length + name.length + data.length
    }
    const centralOffset = offset
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20)
    return Buffer.concat([...localParts, ...centralParts, end])
  }

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })

  function crc32(data: Uint8Array): number {
    let c = 0xffffffff
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  async function listMcpStatus(rawBody: Record<string, unknown> = {}) {
    const workspaceRoot = stringOr(rawBody.workspaceRoot ?? rawBody.working_dir, getDefaultWorkspaceDir())
    const gatedMcp = resolveMcpConfig(rawBody, workspaceRoot)
    const mcpConfigPath = gatedMcp.path
    if (!mcpConfigPath) return { servers: [], ...(gatedMcp.warning ? { untrusted_workspace_config: true, note: gatedMcp.warning } : {}) }
    const configs = await loadMcpConfigFile(mcpConfigPath).catch(() => [])
    const loaded = await loadMcpToolsFromFile(mcpConfigPath, {
      cwd: workspaceRoot,
      timeoutMs: 5000,
      fetchImpl: opts.fetchImpl,
      oauth: { storageDir: mcpOAuthDir, interactive: false }, // server 列表查询,不触发授权弹窗
    })
    try {
      const connected = new Map(loaded.connections.map(connection => [connection.serverName, connection]))
      const warningText = loaded.warnings.join('\n')
      return {
        servers: configs.map(config => {
          const connection = connected.get(config.name)
          return {
            name: config.name,
            command: config.command,
            url: config.url,
            status: config.disabled === true ? 'disabled' : connection ? 'connected' : warningText.includes(`"${config.name}"`) ? 'error' : 'configured',
            tools: connection?.tools.length ?? 0,
            disabled: config.disabled === true,
          }
        }),
      }
    } finally {
      await closeMcpConnections(loaded.connections)
    }
  }

  async function mediaUnavailable() {
    return Response.json({ ok: false, detail: '媒体后端未配置' }, { status: 503 })
  }

  function videoEditError(error: unknown): Response {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof VideoEditError ? error.status : 500
    return jsonDetailError(message, status)
  }

  async function handleStudioRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/studio/')) return null
    const workbenchResponse = await handleImageWorkbenchRoute(url, req)
    if (workbenchResponse) return workbenchResponse
    const action = url.pathname.slice('/api/v1/studio/'.length)
    const generationMatch = action.match(/^generation\/(.+)$/)
    if (generationMatch && req.method === 'GET') {
      const local = media.localGeneration(decodeURIComponent(generationMatch[1]!))
      if (local) return Response.json(local)
      if (media.hasBackend) return Response.json(await media.proxyJson(url.pathname, undefined, 'GET'))
      return Response.json({ ok: false, detail: '没找到这张本地预览成品' }, { status: 404 })
    }
    if (action === 'brief/compile' && req.method === 'POST') {
      try {
        const body = imageBriefCompileRequestSchema.parse(await req.json().catch(() => ({})))
        const brief = media.compileBrief(body as Record<string, unknown>)
        return Response.json(imageBriefCompileResponseSchema.parse({ brief, understanding: brief.understanding ?? brief.user_request }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'generate' && req.method === 'POST') {
      try {
        const rawBody = studioGenerateRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = rawBody.reference_image_paths ?? []
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startStudioGenerate(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'edit' && req.method === 'POST') {
      try {
        const rawBody = studioEditRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = [rawBody.mask_path, rawBody.source_image_path].filter((item): item is string => typeof item === 'string')
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startStudioEdit(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'upscale' && req.method === 'POST') {
      try {
        const rawBody = studioUpscaleRequestSchema.parse(await req.json().catch(() => ({})))
        const trusted = typeof rawBody.source_image_path === 'string' ? [rawBody.source_image_path] : []
        const body: Record<string, unknown> = { ...rawBody, _trusted_image_paths: trusted }
        return Response.json(await media.startUpscale(body, {
          conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : undefined,
          workspaceRoot: stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir()),
        }))
      } catch (err) {
        return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
      }
    }
    if (action === 'expand' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/expand', body))
      return Response.json({ image_prompt: stringOr(body.prompt, '') })
    }
    if (action === 'storyboard' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>
      if (media.hasBackend) return Response.json(await media.proxyJson('/api/v1/studio/storyboard', body))
      return Response.json(localStoryboard(body))
    }
    if (media.hasBackend) {
      const body = req.method === 'GET' ? undefined : await req.json().catch(() => ({})) as Record<string, unknown>
      return Response.json(await media.proxyJson(url.pathname, body, req.method))
    }
    return await mediaUnavailable()
  }

  async function handleVideoEditRoute(url: URL, req: Request): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/v1/video-edit/')) return null
    const v2Response = await handleVideoEditV2Route(url, req.clone() as unknown as Request)
    if (v2Response) return v2Response
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({})) as Record<string, unknown>
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : undefined
    const workspaceRoot = stringOr(body.workspaceRoot ?? body.working_dir, getDefaultWorkspaceDir())

    if (url.pathname === '/api/v1/video-edit/localfile' && req.method === 'GET') {
      return await videoEdits.localFileResponse(url.searchParams.get('path'), req.headers.get('range'))
    }

    if (url.pathname === '/api/v1/video-edit/inventory' && req.method === 'POST') {
      const project = typeof body.project === 'string' ? body.project : undefined
      return Response.json(await media.startVideoJob('video_inventory', '/api/v1/video-edit/inventory', body, {
        conversationId,
        workspaceRoot,
        project,
        title: '视频素材理解',
      }))
    }
    const renderMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)\/(render|render_v2)$/)
    if (renderMatch && req.method === 'POST') {
      const project = decodeURIComponent(renderMatch[1]!)
      const action = renderMatch[2]!
      return Response.json(await media.startVideoJob('video_render', `/api/v1/video-edit/projects/${encodeURIComponent(project)}/${action}`, body, {
        conversationId,
        workspaceRoot,
        project,
        title: action === 'render_v2' ? 'V2 视频出片' : '视频出片',
      }))
    }

    const projectActionMatch = url.pathname.match(/^\/api\/v1\/video-edit\/projects\/([^/]+)(?:\/([^/]+))?$/)
    if (projectActionMatch) {
      const project = decodeURIComponent(projectActionMatch[1]!)
      const action = projectActionMatch[2] ? decodeURIComponent(projectActionMatch[2]) : ''
      if (media.hasBackend) {
        return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
      }
      try {
        if (!action && req.method === 'GET') {
          return Response.json(await videoEdits.getProject(project))
        }
        if (action === 'ops' && req.method === 'POST') {
          return Response.json(await videoEdits.applyOperations(project, body.operations))
        }
        if (action === 'auto_caption' && req.method === 'POST') {
          return Response.json(await videoEdits.autoCaption(project, body.track))
        }
        if (action === 'recaption' && req.method === 'POST') {
          return Response.json(await videoEdits.recaption(project, body.tonality))
        }
        if (action === 'edit_feedback' && req.method === 'POST') {
          return Response.json(await videoEdits.editFeedback(project, body.feedback))
        }
      } catch (error) {
        return videoEditError(error)
      }
    }

    if (media.hasBackend) {
      return Response.json(await media.proxyJson(url.pathname, req.method === 'GET' ? undefined : body, req.method))
    }
    return await mediaUnavailable()
  }

  const app = Bun.serve<AgentWsData>({
    hostname: host,
    port,
    idleTimeout: 30,
    async fetch(req, server) {
      const preflight = localCorsPreflight(req)
      if (preflight) return preflight
      const response = await (async (): Promise<Response | undefined> => {
      const url = new URL(req.url)

      if (url.pathname === '/agent/ws') {
        const conversationId = stringOr(url.searchParams.get('conversationId'), crypto.randomUUID())
        const after = numberFrom(url.searchParams.get('after'), 0)
        if (server.upgrade(req, { data: { conversationId, after } satisfies AgentWsData })) {
          return undefined as unknown as Response
        }
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: 'ts-harness', ts: Date.now() })
      }

      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const localUpload = await serveLocalUpload(url.pathname)
        if (localUpload) return localUpload
        const upload = media.serveUpload(url.pathname)
        if (upload) return upload
      }

      if (url.pathname === '/api/v1/backup/export' && req.method === 'GET') {
        return new Response(JSON.stringify({
          exported_at: new Date().toISOString(),
          store: await desktopData.getStore(),
          byok: await desktopData.getByok(),
          // 自造店脑记忆已下线(改用 cc AutoMem memdir);保留空数组兼容旧备份格式。
          memories: [],
          scheduled_tasks: await desktopData.listScheduledTasks(),
          store_docs: await desktopData.getStoreDocs(),
        }, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="billiardbuddy-backup.json"',
          },
        })
      }

      const studioResponse = await handleStudioRoute(url, req)
      if (studioResponse) return studioResponse

      const videoEditResponse = await handleVideoEditRoute(url, req)
      if (videoEditResponse) return videoEditResponse

      const canvasResponse = await handleCanvasRoute(url, req)
      if (canvasResponse) return canvasResponse

      if (url.pathname === '/api/v1/stores' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.updateStore(body), { status: 201 })
      }

      if (url.pathname === '/api/v1/stores/me') {
        if (req.method === 'GET') return Response.json(await desktopData.getStore())
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.updateStore(body))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/logo' || url.pathname === '/api/v1/stores/me/qrcode') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return await saveUpload(req, url.pathname.endsWith('/logo') ? 'logo' : 'qrcode')
      }

      if (url.pathname === '/api/v1/uploads/image') {
        // 通用图片上传(区域截图/聊天附图)→ 返回 /uploads/local url。供"基于此调整"+ 贴图。
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return await saveLocalImageAttachment(stateRoot, req)
      }

      if (url.pathname === '/api/v1/stores/me/byok') {
        if (req.method === 'GET') return Response.json(await desktopData.getByok())
        if (req.method === 'PUT' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const updated = await desktopData.updateByok(body)
          await syncLegacyByokTextProvider(body, updated)
          return Response.json(updated)
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/stores/me/byok/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await desktopData.validateByok(body))
      }

      if (url.pathname === '/api/v1/stores/me/byok/profiles') {
        if (req.method === 'GET') return Response.json(await desktopData.listByokProfiles())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.addByokProfile(body))
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const byokProfileMatch = url.pathname.match(/^\/api\/v1\/stores\/me\/byok\/profiles\/([^/]+)(?:\/(activate))?$/)
      if (byokProfileMatch) {
        const name = decodeURIComponent(byokProfileMatch[1]!)
        const action = byokProfileMatch[2]
        if (action === 'activate' && req.method === 'POST') return Response.json(await desktopData.activateByokProfile(name))
        if (!action && req.method === 'DELETE') return Response.json(await desktopData.deleteByokProfile(name))
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/assets/status') {
        // 资产管理器全量状态(前端"正在准备组件 x%"UI 的拉取口;增量走 WS asset_progress)。
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(assets.status())
      }

      if (url.pathname === '/api/v1/voice/transcribe') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const form = await req.formData().catch(() => null)
        const file = form?.get('file')
        if (!(file instanceof File)) return jsonDetailError('file required', 400)
        try {
          return Response.json(voiceTranscriptionResponseSchema.parse(await transcribeVoiceFile(file, { stateRoot, env: opts.env ?? process.env })))
        } catch (err) {
          const status = err instanceof VoiceTranscriptionError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/logs/client') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/scheduled-tasks') {
        if (req.method === 'GET') return Response.json(await desktopData.listScheduledTasks())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await desktopData.createScheduledTask(body), { status: 201 })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      // 运行历史:GET /api/v1/scheduled-tasks/:id/runs
      const scheduledRunsMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/runs$/)
      if (scheduledRunsMatch) {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const id = decodeURIComponent(scheduledRunsMatch[1]!)
        return Response.json({ runs: await scheduledTasks.getTaskRuns(id) })
      }

      // 立即运行:POST /api/v1/scheduled-tasks/:id/run(面板 Run Now,无视排程直接起一个真会话)
      const scheduledRunMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)\/run$/)
      if (scheduledRunMatch) {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const id = decodeURIComponent(scheduledRunMatch[1]!)
        const run = await scheduledTasks.runTaskNow(id)
        if (!run) return jsonDetailError('scheduled task not found', 404)
        return Response.json(run, { status: 202 })
      }

      const scheduledMatch = url.pathname.match(/^\/api\/v1\/scheduled-tasks\/([^/]+)$/)
      if (scheduledMatch) {
        const id = decodeURIComponent(scheduledMatch[1]!)
        if (req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const item = await desktopData.updateScheduledTask(id, body)
          if (!item) return jsonDetailError('scheduled task not found', 404)
          return Response.json(item)
        }
        if (req.method === 'DELETE') {
          await desktopData.deleteScheduledTask(id)
          return Response.json({ status: 'ok' })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/store-docs') {
        if (req.method === 'GET') return Response.json(await desktopData.getStoreDocs())
        if (req.method === 'PUT') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json(await storeDocs.setFolder(typeof body.folder_path === 'string' ? body.folder_path : null))
        }
        if (req.method === 'DELETE') return Response.json(await storeDocs.clear())
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/store-docs/reindex') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json(await storeDocs.reindex())
      }

      if (url.pathname === '/api/v1/store-docs/search') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const query = typeof body.query === 'string' ? body.query : ''
        const top = typeof body.top === 'number' ? body.top : 5
        const paths = Array.isArray(body.paths)
          ? body.paths.filter((item): item is string => typeof item === 'string')
          : typeof body.path === 'string'
            ? body.path
            : undefined
        return Response.json({ hits: await storeDocs.search(query, top, { paths }) })
      }

      if (url.pathname === '/api/v1/notifications') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await desktopData.notificationsAfter(numberFrom(url.searchParams.get('after'), 0)))
      }

      if (url.pathname === '/model/health/clear' || url.pathname === '/api/model/health/clear') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          return Response.json(await clearModelHealth(body))
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/model' || url.pathname === '/api/model') {
        if (req.method === 'GET') {
          const status = await currentModelStatus()
          return Response.json(status, { status: status.ok ? 200 : 503 })
        }
        if (req.method === 'POST' || req.method === 'PATCH') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const providerId = typeof body.providerId === 'string'
            ? body.providerId.trim()
            : typeof body.id === 'string'
              ? body.id.trim()
              : ''
          try {
            if (!providerId || providerId === 'env' || providerId === 'default') await providers.clearActive()
            else await providers.activate(providerId)
            const status = await currentModelStatus()
            return Response.json(status, { status: status.ok ? 200 : 503 })
          } catch (err) {
            return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
          }
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/skills') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const skills = await loadLayeredSkills({ bundledRoot: opts.skillsRoot ?? defaultSkillsRoot() })
        return Response.json({
          skills: skills.skills.map(skill => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            argument_hint: skill.whenToUse,
            user_invocable: true,
          })),
        })
      }

      if (url.pathname === '/api/v1/agent/output-styles') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const styles = await loadOutputStyles()
        return Response.json({ output_styles: styles.styles.map(publicOutputStyle) })
      }

      if (url.pathname === '/api/v1/agent/packs') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ packs: listPublicDomainPacks() })
      }

      // 给前端 / 面板列可调用的技能/命令(对齐 cc「斜杠命令=技能」发现清单):
      // 汇总 builtin 命令 + 已加载技能 + 已启用领域包命令(启用 billiards 时含 /台球、billiards:*)。
      // GET /api/v1/agent/commands?conversationId=&enabledPacks=台球[,球房]&working_dir=
      if (url.pathname === '/api/v1/agent/commands') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const workspaceRoot = url.searchParams.get('working_dir') || url.searchParams.get('workspaceRoot') || getDefaultWorkspaceDir()
        const workspace = new Workspace(workspaceRoot)
        const queryPacks = [
          ...url.searchParams.getAll('enabledPacks'),
          ...url.searchParams.getAll('enabled_packs'),
          ...url.searchParams.getAll('knowledge_packs'),
          ...url.searchParams.getAll('knowledgePacks'),
        ].flatMap(value => value.split(/[,，]/)).map(value => value.trim()).filter(Boolean)
        const enabledPacks = resolveEnabledPacks({
          enabled_packs: queryPacks.length > 0 ? queryPacks : undefined,
          billiards_mode: url.searchParams.get('billiards_mode') === 'true' || url.searchParams.get('billiardsMode') === 'true',
        })
        const [skills, commands] = await Promise.all([
          loadLayeredSkills({ bundledRoot: opts.skillsRoot ?? defaultSkillsRoot(), workspaceRoot: workspace.root }),
          loadCommandsForWorkspace(workspace.root, opts.commandsRoot ?? defaultCommandsRoot(), enabledPacks, opts.env ?? process.env),
        ])
        return Response.json({ commands: toPublicCommandEntries(collectDiscoveryEntries({ commands, skills })) })
      }

      if (url.pathname === '/api/v1/agent/mcp') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await listMcpStatus({ workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined }))
      }

      if (url.pathname === '/api/v1/agent/workspace-status') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const workspaceRoot = url.searchParams.get('working_dir') || url.searchParams.get('workspaceRoot') || getDefaultWorkspaceDir()
        const workspace = new Workspace(workspaceRoot)
        const [git, projectInstructions, tree] = await Promise.all([
          getWorkspaceGitStatus(workspaceRoot),
          summarizeWorkspaceProjectInstructions(workspace),
          summarizeWorkspaceTree(workspaceRoot),
        ])
        return Response.json({ root: workspaceRoot, git, projectInstructions, tree })
      }

      if (url.pathname === '/api/v1/agent/bridge/peers') {
        try {
          if (req.method === 'GET') return Response.json({ peers: await bridgePeers.list() })
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ peer: await bridgePeers.register({
              sessionId: stringOr(body.sessionId ?? body.session_id, ''),
              label: typeof body.label === 'string' ? body.label : undefined,
              workspaceRoot: typeof body.workspaceRoot === 'string' ? body.workspaceRoot : typeof body.workspace_root === 'string' ? body.workspace_root : undefined,
              machineName: typeof body.machineName === 'string' ? body.machineName : typeof body.machine_name === 'string' ? body.machine_name : undefined,
              status: body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error' ? body.status : undefined,
              inboundEnabled: typeof body.inboundEnabled === 'boolean' ? body.inboundEnabled : typeof body.inbound_enabled === 'boolean' ? body.inbound_enabled : undefined,
              lastError: typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined,
            }) }, { status: 201 })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePeerMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/peers\/([^/]+)$/)
      if (bridgePeerMatch) {
        const sessionId = decodeURIComponent(bridgePeerMatch[1]!)
        try {
          if (req.method === 'PATCH') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const status = body.status === 'connected' || body.status === 'connecting' || body.status === 'disconnected' || body.status === 'outbound_only' || body.status === 'error'
              ? body.status
              : undefined
            if (!status) return jsonError('status required', 400)
            const peer = await bridgePeers.updateStatus(sessionId, status, typeof body.lastError === 'string' ? body.lastError : typeof body.last_error === 'string' ? body.last_error : undefined)
            if (!peer) return jsonError('bridge peer not found', 404)
            return Response.json({ peer })
          }
          if (req.method === 'DELETE') {
            await bridgePeers.unregister(sessionId)
            return Response.json({ ok: true })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/api/v1/agent/bridge/code-sessions') {
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const config = bridgeCodeSessionConfigFromBody(body, opts.env ?? process.env)
          if (!config) return jsonError('bridge code session client is not configured', 400)
          const title = stringOr(body.title, 'Desktop Coding Agent Session')
          const tags = stringArray(body.tags)
          const client = createBridgeCodeSessionClient({ ...config, fetchImpl: opts.fetchImpl })
          const created = await client.createCodeSession({ title, tags })
          if (!created.ok) return jsonError(created.error, created.status ?? 502)
          await bridgePeers.register({
            sessionId: created.value,
            label: title,
            status: 'outbound_only',
            inboundEnabled: false,
          })
          return Response.json({ ok: true, sessionId: created.value, status: created.status })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeCodeCredentialsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/credentials$/)
      if (bridgeCodeCredentialsMatch) {
        const sessionId = decodeURIComponent(bridgeCodeCredentialsMatch[1]!)
        const codeSessionId = sessionId.startsWith('bridge:') ? sessionId.slice('bridge:'.length) : sessionId
        try {
          if (req.method === 'GET') {
            const credentials = await bridgeRemote.getCredentials(sessionId)
            if (!credentials) return jsonError('bridge credentials not found', 404)
            return Response.json({ credentials })
          }
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const config = bridgeCodeSessionConfigFromBody(body, opts.env ?? process.env)
            if (!config) return jsonError('bridge code session client is not configured', 400)
            const trustedDeviceToken = stringOr(body.trustedDeviceToken ?? body.trusted_device_token, '')
            const client = createBridgeCodeSessionClient({ ...config, fetchImpl: opts.fetchImpl })
            const fetched = await client.fetchRemoteCredentials(codeSessionId, trustedDeviceToken || undefined)
            if (!fetched.ok) return jsonError(fetched.error, fetched.status ?? 502)
            const credentials = await bridgeRemote.storeCredentials(codeSessionId, fetched.value)
            await bridgePeers.register({
              sessionId: codeSessionId,
              status: 'outbound_only',
              inboundEnabled: false,
            })
            return Response.json({ ok: true, sessionId: codeSessionId, credentials, status: fetched.status })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeWorkerMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/worker$/)
      if (bridgeWorkerMatch) {
        const sessionId = decodeURIComponent(bridgeWorkerMatch[1]!)
        const codeSessionId = sessionId.startsWith('bridge:') ? sessionId.slice('bridge:'.length) : sessionId
        try {
          if (req.method === 'GET') {
            const worker = bridgeWorkers.get(codeSessionId)
            const stream = bridgeWorkerStreams.get(codeSessionId)
            return Response.json({
              sessionId: codeSessionId,
              connected: !!worker,
              workerEpoch: worker?.getWorkerEpoch(),
              stream: stream ? { state: stream.getState(), lastSequenceNum: stream.getLastSequenceNum() } : null,
              refresh: bridgeWorkerRefreshStatus(codeSessionId),
            })
          }
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const credentials = await bridgeRemote.getCredentials(codeSessionId)
            if (!credentials) return jsonError('bridge credentials not found', 404)
            const started = await startBridgeWorker(codeSessionId, credentials, body)
            return Response.json({ ok: true, sessionId: codeSessionId, workerEpoch: started.worker.getWorkerEpoch(), initStatus: started.initialized.status, stream: started.streamEnabled, initialSequenceNum: started.initialSequence })
          }
          if (req.method === 'DELETE') {
            closeBridgeWorkerRuntime(codeSessionId, { cancelRefresh: true })
            await bridgePeers.updateStatus(codeSessionId, 'outbound_only').catch(() => undefined)
            return Response.json({ ok: true, sessionId: codeSessionId })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeWorkerActionMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/code-sessions\/([^/]+)\/worker\/(event|internal-event|state|metadata|delivery|heartbeat|flush|refresh)$/)
      if (bridgeWorkerActionMatch) {
        const sessionId = decodeURIComponent(bridgeWorkerActionMatch[1]!)
        const codeSessionId = sessionId.startsWith('bridge:') ? sessionId.slice('bridge:'.length) : sessionId
        const action = bridgeWorkerActionMatch[2]!
        try {
          if (action === 'refresh') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const refreshed = await refreshBridgeWorkerCredentialsAndTransport(codeSessionId, body, 'manual_refresh', true)
            return Response.json({
              ok: true,
              sessionId: codeSessionId,
              workerEpoch: refreshed.started.worker.getWorkerEpoch(),
              refreshStatus: refreshed.status,
              initStatus: refreshed.started.initialized.status,
              stream: refreshed.started.streamEnabled,
              initialSequenceNum: refreshed.started.initialSequence,
              refresh: bridgeWorkerRefreshStatus(codeSessionId),
            })
          }
          const worker = bridgeWorkers.get(codeSessionId)
          if (!worker) return jsonError('bridge worker is not connected', 409)
          if (action === 'heartbeat') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const result = await worker.sendHeartbeatNow()
            if (!result.ok) return jsonError(result.error || `heartbeat failed ${result.status ?? ''}`.trim(), result.status ?? 502)
            return Response.json({ ok: true, status: result.status })
          }
          if (action === 'flush') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            await worker.flush()
            return Response.json({ ok: true })
          }
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          if (action === 'event') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const event = isRecord(body.event) ? body.event : body
            if (typeof event.type !== 'string') return jsonError('event.type required', 400)
            await worker.writeEvent(event as Record<string, unknown> & { type: string })
            return Response.json({ ok: true })
          }
          if (action === 'internal-event') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const eventType = stringOr(body.eventType ?? body.event_type ?? body.type, '')
            const payload = isRecord(body.payload) ? body.payload : {}
            if (!eventType) return jsonError('eventType required', 400)
            await worker.writeInternalEvent(eventType, payload, {
              isCompaction: body.isCompaction === true || body.is_compaction === true,
              agentId: stringOr(body.agentId ?? body.agent_id, '') || undefined,
            })
            return Response.json({ ok: true })
          }
          if (action === 'state') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const state = bridgeWorkerSessionStateFrom(body.state ?? body.worker_status)
            if (!state) return jsonError('state required', 400)
            worker.reportState(state, isRecord(body.details) ? {
              tool_name: stringOr(body.details.tool_name ?? body.details.toolName, ''),
              action_description: stringOr(body.details.action_description ?? body.details.actionDescription, ''),
              tool_use_id: stringOr(body.details.tool_use_id ?? body.details.toolUseId, ''),
              request_id: stringOr(body.details.request_id ?? body.details.requestId, ''),
              input: isRecord(body.details.input) ? body.details.input : undefined,
            } : undefined)
            return Response.json({ ok: true })
          }
          if (action === 'metadata') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const metadata = isRecord(body.metadata) ? body.metadata : body
            worker.reportMetadata(metadata)
            return Response.json({ ok: true })
          }
          if (action === 'delivery') {
            if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
            const eventId = stringOr(body.eventId ?? body.event_id, '')
            const status = body.status === 'received' || body.status === 'processing' || body.status === 'processed' ? body.status : undefined
            if (!eventId || !status) return jsonError('eventId and status required', 400)
            worker.reportDelivery(eventId, status)
            return Response.json({ ok: true })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeEventsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/events$/)
      if (bridgeEventsMatch) {
        const sessionId = decodeURIComponent(bridgeEventsMatch[1]!)
        try {
          if (req.method === 'GET') {
            return Response.json({
              events: await bridgeRemote.listEvents(sessionId, {
                after: numberFrom(url.searchParams.get('after'), 0),
                limit: numberFrom(url.searchParams.get('limit'), 100),
              }),
            })
          }
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const event = isRecord(body.event) ? body.event : body
            return Response.json(await bridgeRemote.ingestEvent(sessionId, event), { status: 201 })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeInboundMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/inbound(?:\/resolve)?$/)
      if (bridgeInboundMatch) {
        const sessionId = decodeURIComponent(bridgeInboundMatch[1]!)
        try {
          if (req.method === 'GET') {
            return Response.json({
              messages: await bridgeRemote.listInboundMessages(sessionId, {
                after: numberFrom(url.searchParams.get('after'), 0),
                limit: numberFrom(url.searchParams.get('limit'), 100),
              }),
            })
          }
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const event = isRecord(body.event) ? body.event : isRecord(body.message) ? body.message : body
            const config = bridgeRemoteConfigFromBody(body, opts.env ?? process.env)
            const resolved = await resolveInboundUserMessage(event, {
              sessionId,
              stateRoot,
              baseUrl: config?.baseUrl,
              token: config?.token,
              fetchImpl: opts.fetchImpl,
            })
            if (!resolved) return jsonError('inbound user message content not found', 400)
            const store = body.store !== false
            const record = store ? await bridgeRemote.storeInboundMessage(sessionId, resolved) : undefined
            const dispatch = body.autoRun === true || body.auto_run === true || body.conversationId || body.conversation_id
              ? await dispatchBridgeInboundToAgent({ ...body, bridgeSessionId: sessionId }, resolved)
              : undefined
            return Response.json({ resolved, ...(record ? { message: record } : {}), ...(dispatch ? { dispatch } : {}) }, { status: 201 })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePermissionsMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions$/)
      if (bridgePermissionsMatch) {
        const sessionId = decodeURIComponent(bridgePermissionsMatch[1]!)
        try {
          if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
          return Response.json({ permissions: await bridgeRemote.listPermissions(sessionId, bridgePermissionStatusFrom(url.searchParams.get('status'))) })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgePermissionRespondMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/permissions\/([^/]+)\/respond$/)
      if (bridgePermissionRespondMatch) {
        const sessionId = decodeURIComponent(bridgePermissionRespondMatch[1]!)
        const requestId = decodeURIComponent(bridgePermissionRespondMatch[2]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const result = await bridgeRemote.respondToPermission(sessionId, requestId, bridgePermissionResponseFrom(body))
          if (!result) return jsonError('bridge permission request not found', 404)
          return Response.json(result)
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox$/)
      if (bridgeOutboxMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxMatch[1]!)
        try {
          if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
          return Response.json({ outbox: await bridgeRemote.listOutbox(sessionId, bridgeOutboxStatusFrom(url.searchParams.get('status'))) })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxSentMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/([^/]+)\/sent$/)
      if (bridgeOutboxSentMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxSentMatch[1]!)
        const outboxId = decodeURIComponent(bridgeOutboxSentMatch[2]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const item = await bridgeRemote.markOutboxSent(sessionId, outboxId)
          if (!item) return jsonError('bridge outbox item not found', 404)
          return Response.json({ outbox: item })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const bridgeOutboxFlushMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/outbox\/flush$/)
      if (bridgeOutboxFlushMatch) {
        const sessionId = decodeURIComponent(bridgeOutboxFlushMatch[1]!)
        try {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const config = bridgeRemoteConfigFromBody(body, opts.env ?? process.env)
          if (!config) return jsonError('bridge remote transport is not configured', 400)
          const transport = createBridgeRemoteTransport({ ...config, fetchImpl: opts.fetchImpl })
          const queued = await bridgeRemote.listOutbox(sessionId, 'queued')
          const results: Array<Record<string, unknown>> = []
          for (const item of queued) {
            const sent = await transport.sendOutboxItem(item)
            if (sent.ok) {
              const marked = await bridgeRemote.markOutboxSent(sessionId, item.id)
              results.push({ id: item.id, requestId: item.requestId, ok: true, status: sent.status, outbox: marked })
            } else {
              results.push({ id: item.id, requestId: item.requestId, ok: false, status: sent.status, error: sent.error })
            }
          }
          return Response.json({ ok: results.every(item => item.ok === true), flushed: results.filter(item => item.ok === true).length, total: results.length, results })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/api/v1/agent/bridge/subscribers') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({
          subscribers: [...bridgeSubscribers.entries()].map(([sessionId, subscriber]) => ({
            sessionId,
            connected: subscriber.isConnected(),
          })),
        })
      }

      const bridgeSubscribeMatch = url.pathname.match(/^\/api\/v1\/agent\/bridge\/sessions\/([^/]+)\/subscribe$/)
      if (bridgeSubscribeMatch) {
        const sessionId = decodeURIComponent(bridgeSubscribeMatch[1]!)
        try {
          if (req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const config = bridgeRemoteConfigFromBody(body, opts.env ?? process.env)
            if (!config) return jsonError('bridge remote subscriber is not configured', 400)
            bridgeSubscribers.get(sessionId)?.close()
            const subscriber = new BridgeRemoteSubscriber(sessionId, {
              baseUrl: config.baseUrl,
              token: config.token,
              orgUuid: config.orgUuid,
              WebSocketCtor: opts.bridgeWebSocketCtor,
            }, { state: bridgeRemote, peers: bridgePeers, inbound: {
              stateRoot,
              fetchImpl: opts.fetchImpl,
              onResolved: async resolved => { await dispatchBridgeInboundToAgent({ ...body, bridgeSessionId: sessionId }, resolved) },
            }, onEvent: async payload => { await projectBridgeEventToConversation(body, payload) } })
            bridgeSubscribers.set(sessionId, subscriber)
            subscriber.connect()
            return Response.json({ ok: true, sessionId, connected: subscriber.isConnected() })
          }
          if (req.method === 'DELETE') {
            const subscriber = bridgeSubscribers.get(sessionId)
            subscriber?.close()
            bridgeSubscribers.delete(sessionId)
            return Response.json({ ok: true, sessionId })
          }
          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      if (url.pathname === '/api/v1/agent/mcp/presets') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ presets: MCP_PRESETS })
      }

      if (url.pathname === '/api/v1/agent/mcp/trust') {
        // 工作区级 .mcp.json 信任闸:GET 查已信任列表;POST {workspaceRoot} 批准;DELETE 撤销。
        if (req.method === 'GET') return Response.json({ approved_workspace_roots: mcpTrust.list() })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const root = stringOr(body.workspaceRoot ?? body.working_dir, '')
        if (!root) return jsonError('缺少 workspaceRoot', 400)
        if (req.method === 'DELETE') { mcpTrust.revoke(root); return Response.json({ ok: true, trusted: false, approved_workspace_roots: mcpTrust.list() }) }
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        mcpTrust.trust(root)
        return Response.json({ ok: true, trusted: true, approved_workspace_roots: mcpTrust.list() })
      }

      if (url.pathname === '/api/v1/agent/mcp/add') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await addMcpServer(body, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/mcp/remove') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await removeMcpServer(body.name, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/mcp/toggle') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await setMcpServerDisabled(body.name, body.disabled, defaultWritableMcpConfigPath(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/plugins') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ plugins: await listPlugins(defaultPluginRoots(opts.env ?? process.env)) })
      }

      // 文件系统浏览(§7 工作区目录树):列一个目录的直接子项(dirs 优先),只读、隐藏文件跳过、上限 500。
      if (url.pathname === '/api/v1/agent/fs/list' && req.method === 'GET') {
        const dirPath = url.searchParams.get('path')
        if (!dirPath) return Response.json({ error: 'path required' }, { status: 400 })
        try {
          // 工作区树给的是相对 root 的路径;按 working_dir(店主选的工作目录)解析,绝对路径原样。
          // resolve(base, p):p 绝对则返回 p,相对则相对 base——正好两种都对。修相对路径错解析到 sidecar cwd 的 bug。
          const resolved = resolve(url.searchParams.get('working_dir') || getDefaultWorkspaceDir(), dirPath)
          const dirents = await readdir(resolved, { withFileTypes: true })
          const entries = dirents
            .filter(d => !d.name.startsWith('.'))
            .map(d => ({ name: d.name, isDir: d.isDirectory() }))
            .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
            .slice(0, 500)
          return Response.json({ path: resolved, entries })
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
        }
      }

      // 文件读(§9 右侧预览):读一个文本文件内容,上限 256KB,供预览面板显示改动后的文件。
      if (url.pathname === '/api/v1/agent/fs/read' && req.method === 'GET') {
        const filePath = url.searchParams.get('path')
        if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
        try {
          const resolved = resolve(url.searchParams.get('working_dir') || getDefaultWorkspaceDir(), filePath)
          const stat = await import('node:fs/promises').then(m => m.stat(resolved))
          if (stat.size > 256 * 1024) return Response.json({ path: resolved, truncated: true, content: '(文件超过 256KB,预览已截断)' })
          return Response.json({ path: resolved, content: await readFile(resolved, 'utf8') })
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
        }
      }

      // 原始文件字节(右面板 <img> 渲染图片等二进制预览):按扩展名给 content-type;越界(../)拒绝。
      // 图片/pdf 是二进制,不能走 fs/read 的 utf8 文本(读出来是乱码)——所以单开一条按字节返回的路。
      if (url.pathname === '/api/v1/agent/fs/raw' && req.method === 'GET') {
        const filePath = url.searchParams.get('path')
        if (!filePath) return new Response('path required', { status: 400 })
        try {
          const wd = url.searchParams.get('working_dir') || getDefaultWorkspaceDir()
          const resolved = resolve(wd, filePath)
          if (relative(wd, resolved).startsWith('..')) return new Response('forbidden', { status: 403 }) // 挡 ../ 穿越
          const info = await import('node:fs/promises').then(m => m.stat(resolved))
          if (info.size > 20 * 1024 * 1024) return new Response('file too large', { status: 413 }) // 预览上限 20MB
          const data = await readFile(resolved)
          const type = RAW_MIME_BY_EXT[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
          return new Response(data, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } })
        } catch (err) {
          return new Response(err instanceof Error ? err.message : String(err), { status: 404 })
        }
      }

      // 文件 diff(右面板改动文件红绿 diff):HEAD 版 vs 工作区版,返回 old/new 供前端 DiffViewer。
      if (url.pathname === '/api/v1/agent/fs/diff' && req.method === 'GET') {
        const filePath = url.searchParams.get('path')
        if (!filePath) return Response.json({ error: 'path required' }, { status: 400 })
        try {
          const resolved = resolve(url.searchParams.get('working_dir') || getDefaultWorkspaceDir(), filePath)
          const newString = await readFile(resolved, 'utf8').catch(() => '')
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileP = promisify(execFile)
          let repoRoot = ''
          try {
            const { stdout } = await execFileP('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(resolved), timeout: 2000 })
            repoRoot = stdout.trim()
          } catch { /* 非 git 仓库 */ }
          let oldString = ''
          if (repoRoot) {
            const rel = relative(repoRoot, resolved)
            try {
              const { stdout } = await execFileP('git', ['--no-optional-locks', 'show', `HEAD:${rel}`], { cwd: repoRoot, timeout: 3000, maxBuffer: 1024 * 1024 })
              oldString = stdout
            } catch { oldString = '' } // git 仓库内未跟踪/新文件 → 视为全新增(符合 git/Codex 语义)
          }
          // ⚠️ 非 git 仓库(repoRoot 空)没有 diff 基准 → changed:false,前端显示纯文件内容;
          // 否则每个文件都被误判成"全绿全新增"假 diff(oldString 空 !== 全文)。git 仓库内才按 HEAD 比。
          const changed = repoRoot ? oldString !== newString : false
          return Response.json({ path: resolved, oldString, newString, changed })
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
        }
      }

      // 配置基座:App 级用户设置(默认权限档/主题),供设置抽屉读写。
      if (url.pathname === '/api/settings') {
        if (req.method === 'GET') return Response.json({ settings: await userSettings.get() })
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          return Response.json({ settings: await userSettings.update(body) })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      // 工作区路径(§P1 持久化 + 新建/现有两条路 + 可配置默认存储路径)。四个动作共用 buildState():
      //   { default(全局默认工作区), base(默认工作空间存储路径,新建落这里), persisted(上次选中), current(启动应恢复到的), exists }。
      // - GET  /api/v1/workspace            → 读状态(前端启动据此回填上次工作目录 →「关窗即忘」修好)。
      // - POST /api/v1/workspace { path }    → 「使用现有文件夹」:把选中的绝对路径存盘(lastWorkspaceRoot),非目录报 400。
      // - POST /api/v1/workspace/create { name } → 「新建工作空间」:在 base 下建同名文件夹 + 初始化项目记忆(BILLIARDBUDDY.md/.billiardbuddy)+ 设为当前,返回绝对路径。
      // - POST /api/v1/workspace/base { path } → 改「默认工作空间存储路径」(workspaceBaseDir)。
      if (url.pathname === '/api/v1/workspace' || url.pathname === '/api/v1/workspace/create' || url.pathname === '/api/v1/workspace/base') {
        const isDir = async (p: string): Promise<boolean> => { try { return (await stat(p)).isDirectory() } catch { return false } }
        const effectiveBase = async (): Promise<string> => (await userSettings.get()).workspaceBaseDir || getDefaultWorkspaceDir()
        const buildState = async (): Promise<Record<string, unknown>> => {
          const settings = await userSettings.get()
          const defaultDir = getDefaultWorkspaceDir()
          const base = settings.workspaceBaseDir || defaultDir
          const persisted = settings.lastWorkspaceRoot ?? null
          const current = persisted && await isDir(persisted) ? persisted : defaultDir
          return { default: defaultDir, base, persisted, current, exists: await isDir(current) }
        }

        // 「新建工作空间」:名字 → base 下建同名文件夹 + 初始化 + 设为当前。
        if (url.pathname === '/api/v1/workspace/create') {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          try {
            const created = await createNamedWorkspace(await effectiveBase(), typeof body.name === 'string' ? body.name : '')
            await userSettings.update({ lastWorkspaceRoot: created.path })
            return Response.json({ ...created, ...(await buildState()) })
          } catch (err) {
            if (err instanceof WorkspaceNameError) return jsonError(err.message, 400)
            return jsonError(err instanceof Error ? err.message : String(err), 500)
          }
        }

        // 改「默认工作空间存储路径」:mkdir -p 兜底,非目录报 400。
        if (url.pathname === '/api/v1/workspace/base') {
          if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const raw = typeof body.path === 'string' ? body.path.trim() : ''
          if (!raw) return jsonError('path required', 400)
          const abs = resolve(raw)
          try { await mkdir(abs, { recursive: true }) } catch { /* 已存在或建不出;下面 isDir 兜底判定 */ }
          if (!await isDir(abs)) return jsonError(`不是可用目录:${raw}`, 400)
          await userSettings.update({ workspaceBaseDir: abs })
          return Response.json(await buildState())
        }

        // /api/v1/workspace 本体:GET 读状态 / POST 设「使用现有文件夹」的选中路径。
        if (req.method === 'GET') return Response.json(await buildState())
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const raw = typeof body.path === 'string' ? body.path.trim() : ''
          if (!raw) return jsonError('path required', 400)
          const abs = resolve(raw)
          try { await mkdir(abs, { recursive: true }) } catch { /* 已存在或建不出;下面 isDir 兜底判定 */ }
          if (!await isDir(abs)) return jsonError(`不是可用目录:${raw}`, 400)
          await userSettings.update({ lastWorkspaceRoot: abs })
          return Response.json(await buildState())
        }
        return new Response('Method not allowed', { status: 405 })
      }

      // 规则持久化:把一条权限规则写进工作区 .claude/settings.local.json(跨重启生效),供"始终允许"选择用。
      if (url.pathname === '/api/v1/agent/permissions/persist' && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const behavior = body.behavior === 'deny' ? 'deny' : body.behavior === 'ask' ? 'ask' : 'allow'
        const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : ''
        if (!toolName) return Response.json({ ok: false, error: 'toolName required' }, { status: 400 })
        const ruleValue = { toolName, ...(typeof body.ruleContent === 'string' && body.ruleContent.trim() ? { ruleContent: body.ruleContent.trim() } : {}) }
        const workspace = workspaceFromBody(body)
        await persistPermissionRule(workspace.root, behavior, ruleValue)
        return Response.json({ ok: true, behavior, rule: ruleValue })
      }
      if (url.pathname === '/api/v1/agent/permissions/rules' && req.method === 'GET') {
        const workspace = workspaceFromBody(Object.fromEntries(url.searchParams))
        return Response.json({ rules: await loadPermissionRules(workspace.root) })
      }

      if (url.pathname === '/api/v1/agent/plugins/toggle') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await setPluginEnabled(body.name, body.enabled, defaultPluginRoots(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/plugins/install') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(await installPluginFromGithub(body.repo, defaultPluginInstallDir(opts.env ?? process.env)))
      }

      if (url.pathname === '/api/v1/agent/execute') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await executeLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/reject') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await rejectLegacyAgentTool(body)
      }

      if (url.pathname === '/api/v1/agent/chat') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        server.timeout(req, 0)
        try {
          return await legacyChatResponse(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return jsonDetailError(err instanceof Error ? err.message : String(err), status)
        }
      }

      if (url.pathname === '/api/v1/agent/daily-drafts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        return Response.json(dailyDraftPayload())
      }

      if (url.pathname === '/api/v1/agent/conversations') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json(await legacyConversations())
      }

      const legacyConversationMatch = url.pathname.match(/^\/api\/v1\/agent\/conversations\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyConversationMatch) {
        const conversationId = legacyConversationMatch[1]!
        if (req.method === 'GET') return Response.json(await legacyConversationMessages(conversationId))
        if (req.method === 'DELETE') {
          await legacyStore.setConversationDeleted(conversationId, true)
          // 会话结束落点:用户删除会话 → 触发 SessionEnd 钩子(reason=clear),fire-and-forget 不阻塞响应。
          await fireSessionEndHooks(conversationId, 'clear')
          return Response.json({ ok: true, conversation_id: conversationId })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/recent-artifacts') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return Response.json({ items: await legacyStore.listArtifacts(numberFrom(url.searchParams.get('limit'), 12), false) })
      }

      if (url.pathname === '/api/v1/agent/saved-artifacts') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          const item = await legacyStore.saveArtifact({
            title: typeof body.title === 'string' ? body.title : undefined,
            content: typeof body.content === 'string' ? body.content : '',
            conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : null,
            kind: typeof body.kind === 'string' ? body.kind : null,
          })
          return Response.json(item)
        } catch (err) {
          return jsonDetailError(err instanceof Error ? err.message : String(err), 400)
        }
      }

      const legacyRecentArtifactMatch = url.pathname.match(/^\/api\/v1\/agent\/recent-artifacts\/([A-Za-z0-9_-]{1,128})(?:\/(rating))?$/)
      if (legacyRecentArtifactMatch) {
        const artifactId = legacyRecentArtifactMatch[1]!
        const action = legacyRecentArtifactMatch[2]
        if (!action && req.method === 'DELETE') {
          await legacyStore.setArtifactDeleted(artifactId, true)
          return Response.json({ ok: true, id: artifactId })
        }
        if (action === 'rating' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const rating = body.rating === 'bad' ? 'bad' : body.rating === 'good' ? 'good' : null
          if (!rating) return jsonDetailError('评价只能是 good 或 bad', 400)
          const ok = await legacyStore.rateArtifact(artifactId, rating, typeof body.note === 'string' ? body.note : null)
          if (!ok) return jsonDetailError('没找到这条成品', 404)
          return Response.json({ ok: true, id: artifactId, rating })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/api/v1/agent/deleted-items') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const limit = numberFrom(url.searchParams.get('limit'), 30)
        const [artifactItems, conversationItems] = await Promise.all([
          legacyStore.listArtifacts(limit, true),
          deletedConversationArtifacts(limit),
        ])
        const items = [...artifactItems, ...conversationItems]
          .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
          .slice(0, Math.max(1, Math.min(80, limit)))
        return Response.json({ items })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) await legacyStore.setConversationDeleted(conversationId, false)
        else if (id) await legacyStore.setArtifactDeleted(id, false)
        else return jsonDetailError('缺少要恢复的内容', 400)
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/purge') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : typeof body.conversationId === 'string' ? body.conversationId : ''
        if (conversationId) {
          await sessions.remove(conversationId)
          await legacyStore.setConversationDeleted(conversationId, false)
        } else if (id) {
          await legacyStore.purgeArtifact(id)
        } else {
          return jsonDetailError('缺少要彻底删除的内容', 400)
        }
        return Response.json({ ok: true })
      }

      if (url.pathname === '/api/v1/agent/deleted-items/clear') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const deletedConversationIds = await legacyStore.clearDeletedConversations()
        await Promise.all(deletedConversationIds.map(id => sessions.remove(id).catch(() => false)))
        await legacyStore.clearDeletedArtifacts()
        return Response.json({ ok: true, removed_file_backups: 0 })
      }

      if (url.pathname === '/api/v1/agent/file-diff') {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        return await fileDiffFromQuery(url)
      }

      if (url.pathname === '/api/v1/agent/file-restore') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return await restoreFileFromBackup(body)
      }

      if (url.pathname === '/api/v1/agent/image/validate') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        return Response.json(validateImageModelPayload(body))
      }

      if (url.pathname === '/api/v1/agent/tasks') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          return Response.json(await startLegacyAgentTask(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, detail: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      const legacyTaskMatch = url.pathname.match(/^\/api\/v1\/agent\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel|message|background))$/)
      if (legacyTaskMatch) {
        const id = legacyTaskMatch[1]!
        const action = legacyTaskMatch[2]!
        if (action === 'events' && req.method === 'GET') {
          server.timeout(req, 0)
          const after = Number.parseInt(url.searchParams.get('after') ?? '-1', 10)
          return new Response(legacyTaskEventStream(id, after), {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          })
        }
        if (action === 'cancel' && req.method === 'POST') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id, ['queued', 'running'])
          const interrupted = task?.conversationId ? turns.interrupt(task.conversationId) : false
          const taskId = task?.id ?? id
          const cancelled = await tasks.cancel(taskId)
          return Response.json({
            ok: true,
            task_id: taskId,
            ...(task && task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task?.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            status: cancelled || interrupted ? 'cancelled' : task?.status ?? 'unknown',
          })
        }
        if (action === 'background' && req.method === 'POST') {
          try {
            const task = await tasks.requestForegroundAgentBackground(id)
            return Response.json({
              ok: true,
              task_id: task.id,
              status: task.status,
              ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            })
          } catch (err) {
            return Response.json({ ok: false, detail: err instanceof Error ? err.message : String(err) }, { status: 404 })
          }
        }
        if (action === 'message' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) return Response.json({ ok: false, detail: 'message required' }, { status: 400 })
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task?.conversationId) return Response.json({ ok: false, detail: 'task not found' }, { status: 404 })
          const inbox = steerInboxes.get(task.conversationId) ?? []
          inbox.push(message)
          steerInboxes.set(task.conversationId, inbox)
          await tasks.appendEvent(task.id, { type: 'steering', content: message }).catch(() => undefined)
          return Response.json({
            ok: true,
            task_id: task.id,
            ...(task.id !== requestedTaskId ? { requested_task_id: requestedTaskId, resolved_task_id: task.id } : {}),
            ...(typeof task.params?.agent_id === 'string' && task.params.agent_id.trim() ? { agent_id: task.params.agent_id.trim() } : {}),
            queued: inbox.length,
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const legacyMediaJobMatch = url.pathname.match(/^\/api\/v1\/agent\/media-jobs\/([A-Za-z0-9_-]{1,128})$/)
      if (legacyMediaJobMatch) {
        if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const status = await media.status(legacyMediaJobMatch[1]!)
        if (!status) return Response.json({ ok: false, detail: '任务不存在或已过期' }, { status: 404 })
        return Response.json(status)
      }

      const providerRoute = providerPath(url)
      if (providerRoute.matched) {
        try {
          const [id, action] = providerRoute.segments

          if (!id) {
            // 白标:前端拉的 providers 列表脱敏——去 baseUrl + 真实 model,只留身份 + 能力档代称。
            if (req.method === 'GET') {
              const listed = await providers.list()
              return Response.json({ activeId: listed.activeId, providers: listed.providers.map(toPublicProviderView) })
            }
            if (req.method === 'POST') {
              const body = await req.json().catch(() => ({})) as Record<string, unknown>
              return Response.json({ provider: await providers.create(body) }, { status: 201 })
            }
            return new Response('Method not allowed', { status: 405 })
          }

          if (id === 'reorder' && !action && req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            const ids = stringArray(body.ids ?? body.providerIds ?? body.order)
            return Response.json(await providers.reorder(ids))
          }

          if (id === 'active' && action === 'clear' && req.method === 'POST') {
            await providers.clearActive()
            return Response.json({ ok: true })
          }

          if (action === 'clear-health' && req.method === 'POST') {
            return Response.json(await clearModelHealth({ providerId: id }))
          }

          if (id === 'test' && req.method === 'POST') {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ result: await providers.testProviderConfig(body, { fetchImpl: opts.fetchImpl }) })
          }

          if (action === 'activate' && req.method === 'POST') {
            return Response.json({ provider: await providers.activate(id) })
          }

          if ((action === 'enable' || action === 'disable') && req.method === 'POST') {
            return Response.json({ provider: await providers.setEnabled(id, action === 'enable') })
          }

          if (action === 'enabled' && (req.method === 'POST' || req.method === 'PATCH')) {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ provider: await providers.setEnabled(id, body.enabled !== false) })
          }

          if (action === 'test' && req.method === 'POST') {
            return Response.json({ result: await providers.testProvider(id, { fetchImpl: opts.fetchImpl }) })
          }

          if (!action && req.method === 'GET') {
            const provider = await providers.get(id)
            if (!provider) return jsonError('provider not found', 404)
            return Response.json({ provider })
          }
          if (!action && (req.method === 'PUT' || req.method === 'PATCH')) {
            const body = await req.json().catch(() => ({})) as Record<string, unknown>
            return Response.json({ provider: await providers.update(id, body) })
          }
          if (!action && req.method === 'DELETE') {
            await providers.delete(id)
            return Response.json({ ok: true })
          }

          return new Response('Method not allowed', { status: 405 })
        } catch (err) {
          return jsonError(err instanceof Error ? err.message : String(err), providerStatusFor(err))
        }
      }

      const commandRoute = url.pathname.match(/^\/(?:api\/)?commands(?:\/(expand))?$/)
      if (commandRoute) {
        const queryPacks = [
          ...url.searchParams.getAll('knowledge_packs'),
          ...url.searchParams.getAll('knowledgePacks'),
          ...url.searchParams.getAll('enabled_packs'),
          ...url.searchParams.getAll('enabledPacks'),
        ].filter(Boolean)
        const queryBridgeOrigin = url.searchParams.get('bridge_origin') === 'true' ||
          url.searchParams.get('bridgeOrigin') === 'true' ||
          url.searchParams.get('remote_control') === 'true' ||
          url.searchParams.get('remoteControl') === 'true'
        const bodyForWorkspace = req.method === 'GET'
          ? {
              working_dir: url.searchParams.get('working_dir') ?? undefined,
              workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined,
              knowledge_packs: queryPacks.length > 0 ? queryPacks : undefined,
              billiards_mode: url.searchParams.get('billiards_mode') === 'true' || url.searchParams.get('billiardsMode') === 'true',
              bridgeOrigin: queryBridgeOrigin || undefined,
            }
          : await req.clone().json().catch(() => ({})) as Record<string, unknown>
        const workspace = workspaceFromBody(bodyForWorkspace)
        const commands = await loadCommandsForWorkspace(workspace.root, opts.commandsRoot ?? defaultCommandsRoot(), resolveEnabledPacks(bodyForWorkspace), opts.env ?? process.env)
        const publicCommands = bodyForWorkspace.bridgeOrigin === true || bodyForWorkspace.bridge_origin === true || bodyForWorkspace.remoteControl === true || bodyForWorkspace.remote_control === true
          ? filterBridgeSafeCommands(commands.commands)
          : commands.commands
        if (!commandRoute[1] && req.method === 'GET') {
          // 用户面清单:过滤 user-invocable:false(与新路由 /api/v1/agent/commands 的 toPublicCommandEntries 一致);
          // disableModelInvocation 是模型面限制,用户仍可敲,不在此过滤。
          return Response.json({ commands: publicCommands.filter(c => c.userInvocable !== false).map(publicCommand) })
        }
        if (commandRoute[1] === 'expand' && req.method === 'POST') {
          const body = bodyForWorkspace
          if (typeof body.name !== 'string') return Response.json({ ok: false, error: 'name required' }, { status: 400 })
          const command = commands.byName.get(normalizeCommandName(body.name))
          if (!command) return Response.json({ ok: false, error: 'command not found' }, { status: 404 })
          return Response.json({ command: publicCommand(command), prompt: await command.getPrompt(typeof body.args === 'string' ? body.args : '', { workspace }) })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      // 最近项目(按 workspaceRoot 聚合会话):多项目 App 的项目选择器数据源。
      if (url.pathname === '/sessions/projects' && req.method === 'GET') {
        const limit = numberFrom(url.searchParams.get('limit') ?? undefined, 20)
        return Response.json({ projects: await sessions.recentProjects(limit) })
      }

      if (url.pathname === '/sessions') {
        if (req.method === 'GET') {
          // ?workspaceRoot= 按项目过滤会话列表(项目视图)。
          const workspaceRoot = url.searchParams.get('workspaceRoot') ?? undefined
          return Response.json({ sessions: await sessions.list(workspaceRoot ? { workspaceRoot } : undefined) })
        }
        if (req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const meta = await sessions.create({
            id: typeof body.id === 'string' ? body.id : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            workspaceRoot: stringOr(body.workspaceRoot, getDefaultWorkspaceDir()),
          })
          return Response.json({ session: meta })
        }
      }

      // 会话管理:PATCH /sessions/:id {title?,pinned?,archived?} 重命名/置顶/归档;DELETE 删除。
      // 侧栏会话右键菜单接这里(原来只改前端本地、刷新即丢)。
      const sessionIdMatch = url.pathname.match(/^\/sessions\/([^/]+)$/)
      if (sessionIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = decodeURIComponent(sessionIdMatch[1]!)
        const existing = await sessions.get(id).catch(() => null)
        if (!existing) return jsonDetailError('session not found', 404)
        if (req.method === 'DELETE') { const ok = await sessions.remove(id); return Response.json({ ok }) }
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        const patch: { title?: string; pinned?: boolean; archived?: boolean } = {}
        if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim()
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
        if (typeof body.archived === 'boolean') patch.archived = body.archived
        return Response.json({ session: await sessions.touch(id, patch) })
      }

      // 会话 fork:用新 id 拷贝源会话 transcript 续接(对齐 cc --fork-session)。
      const sessionForkMatch = url.pathname.match(/^\/sessions\/([^/]+)\/fork$/)
      if (sessionForkMatch && req.method === 'POST') {
        const body = await req.json().catch(() => ({})) as Record<string, unknown>
        try {
          const forked = await sessions.fork(decodeURIComponent(sessionForkMatch[1]!), { title: typeof body.title === 'string' ? body.title : undefined })
          return Response.json({ session: forked })
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 404 })
        }
      }

      if (url.pathname === '/tasks') {
        if (req.method === 'GET') {
          return Response.json({
            tasks: await tasks.list({
              conversationId: url.searchParams.get('conversationId') ?? undefined,
              status: taskStatusFrom(url.searchParams.get('status')),
              limit: numberFrom(url.searchParams.get('limit'), 200),
              collapseResumedBackgroundAgents: true,
            }),
          })
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(events|cancel|background))?$/)
      if (taskMatch) {
        const id = taskMatch[1]!
        const action = taskMatch[2]
        if (!action && req.method === 'GET') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
          const includeEvents = url.searchParams.get('includeEvents') === '1'
          return Response.json({
            task,
            ...taskAliasPayload(task, requestedTaskId),
            ...(includeEvents ? { events: await tasks.loadEvents(task.id, { limit: 100 }) } : {}),
          })
        }
        if (action === 'events' && req.method === 'GET') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id)
          if (!task) return Response.json({ ok: false, error: 'task not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          const events = await tasks.loadEvents(task.id, { after, limit })
          return Response.json({
            events,
            ...taskAliasPayload(task, requestedTaskId),
            nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
          })
        }
        if (action === 'cancel' && req.method === 'POST') {
          const { task, requestedTaskId } = await resolveTaskEndpointTarget(id, ['queued', 'running'])
          const taskId = task?.id ?? id
          return Response.json({
            ok: true,
            cancelled: await tasks.cancel(taskId),
            taskId,
            ...(task && task.id !== requestedTaskId ? { requestedTaskId } : {}),
          })
        }
        if (action === 'background' && req.method === 'POST') {
          try {
            const task = await tasks.requestForegroundAgentBackground(id)
            return Response.json({ ok: true, task, ...taskAliasPayload(task, id) })
          } catch (err) {
            return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 404 })
          }
        }
        return new Response('Method not allowed', { status: 405 })
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,128})(?:\/(interrupt|events|messages|archive))?$/)
      if (sessionMatch) {
        const id = sessionMatch[1]!
        const action = sessionMatch[2]
        if (!action && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const includeEvents = url.searchParams.get('includeEvents') === '1'
          const includeMessages = url.searchParams.get('includeMessages') !== '0'
          return Response.json({
            session,
            ...(includeMessages ? { messages: await sessions.loadTranscript(id) } : {}),
            ...(includeEvents ? { events: await sessions.loadEvents(id, { limit: 100 }) } : {}),
          })
        }
        if (action === 'messages' && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          return Response.json(await sessions.loadTranscriptPage(id, { after, limit }))
        }
        if (action === 'events' && req.method === 'GET') {
          const session = await sessions.get(id)
          if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
          const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
          const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
          const events = await sessions.loadEvents(id, { after, limit })
          if (url.searchParams.get('format') === 'sse') {
            const body = events.map(record => sseReplayLine(record.seq, record.event)).join('')
            return new Response(body, {
              headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
            })
          }
          return Response.json({
            events,
            nextSeq: events.at(-1)?.seq ?? (Number.isFinite(after) ? Math.max(0, after) : 0),
          })
        }
        if (action === 'interrupt' && req.method === 'POST') {
          const interrupted = turns.interrupt(id)
          if (interrupted) {
            await sessions.touch(id, { status: 'interrupted' })
            await sessions.appendEvent(id, { type: 'context_note', text: '任务已请求中断' }).catch(() => undefined)
          }
          return Response.json({ ok: true, interrupted })
        }
        if (action === 'archive' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          try {
            return Response.json(await archiveSession(id, body))
          } catch (err) {
            const status = err instanceof TurnSetupError ? err.status : 500
            return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
          }
        }
      }

      // rewind/checkpoint 上层服务:同时接受裸 /sessions 与 /api/sessions 前缀(验收文档写的是 /api 形状)。
      const rewindMatch = url.pathname.match(/^(?:\/api)?\/sessions\/([A-Za-z0-9_-]{1,128})\/(turn-checkpoints|rewind)$/)
      if (rewindMatch) {
        const id = rewindMatch[1]!
        const action = rewindMatch[2]
        const session = await sessions.get(id)
        if (!session) return Response.json({ ok: false, error: 'session not found' }, { status: 404 })
        if (action === 'turn-checkpoints') {
          if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
          try {
            return Response.json({ checkpoints: await sessionRewind.listTurnCheckpoints(id) })
          } catch (err) {
            return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
          }
        }
        if (action === 'rewind' && req.method === 'POST') {
          const body = await req.json().catch(() => ({})) as Record<string, unknown>
          const selector: RewindTargetSelector = {
            targetUserMessageId: typeof body.targetUserMessageId === 'string' ? body.targetUserMessageId : undefined,
            userMessageIndex: typeof body.userMessageIndex === 'number' ? body.userMessageIndex : undefined,
            expectedContent: typeof body.expectedContent === 'string' ? body.expectedContent : undefined,
          }
          if (!selector.targetUserMessageId && !Number.isInteger(selector.userMessageIndex)) {
            return Response.json({ ok: false, error: 'targetUserMessageId or userMessageIndex is required' }, { status: 400 })
          }
          try {
            const result = body.dryRun === true
              ? await sessionRewind.previewRewind(id, selector)
              : await sessionRewind.executeRewind(id, selector)
            return Response.json(result)
          } catch (err) {
            return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
          }
        }
        return new Response('Method not allowed', { status: 405 })
      }

      if (url.pathname === '/agent/hello') {
        server.timeout(req, 0) // 关掉 Bun 空闲掐断,否则安静的 SSE 流会被杀
        const workspace = new Workspace(getDefaultWorkspaceDir())
        const systemPrompt = await buildSystemPrompt(workspace)
        // demo model:请求列一次工作区,拿到结果后收敛。真模型出口留 W6。
        const demoSteps: AssistantStep[] = [
          { kind: 'tool_calls', text: '看看工作区里有什么', calls: [{ id: '1', name: 'list_dir', input: {} }] },
          { kind: 'final', text: '这是当前工作区的内容。' },
        ]
        const body = (async function* () {
          for await (const ev of runAgentLoop({
            model: scriptedModel(demoSteps),
            registry: buildGeneralRegistry(),
            workspace,
            systemPrompt,
            userMessage: '列一下工作区',
          })) {
            yield sseLine(ev)
          }
          yield sseLine({ type: 'done' })
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      if (url.pathname === '/agent/prewarm') {
        if (req.method !== 'POST' && req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
        const body = req.method === 'POST'
          ? await req.json().catch(() => ({})) as Record<string, unknown>
          : Object.fromEntries(url.searchParams.entries())
        try {
          return Response.json(await prewarm(body))
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
      }

      if (url.pathname === '/agent/run') {
        if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
        const body = await req.json().catch(() => ({})) as Record<string, unknown>

        server.timeout(req, 0)
        let turn: { stream: AsyncGenerator<SessionEventRecord> }
        try {
          turn = await createTurnStream(body)
        } catch (err) {
          const status = err instanceof TurnSetupError ? err.status : 500
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status })
        }
        const bodyStream = (async function* () {
          for await (const record of turn.stream) {
            yield sseLine(record.event)
          }
        })()
        return new Response(bodyStream, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      // ts-desktop 前端静态资源:GET 未命中任何 API 路由 → 从 frontendRoot 服务(Electron/浏览器加载前端)。
      if (req.method === 'GET') {
        const asset = await serveFrontendAsset(url.pathname)
        if (asset) return asset
      }

      return new Response('Not found', { status: 404 })
      })()
      return response ? withLocalCors(response, req) : undefined as unknown as Response
    },
    websocket: {
      open(ws) {
        turnConsumers.onConnect(ws.data.conversationId)
        // 所有连接都订阅资产进度广播(前端据此画"正在准备组件 x%")。
        ws.subscribe(ASSET_WS_TOPIC)
        wsSend(ws, { type: 'ready', conversationId: ws.data.conversationId })
        if (ws.data.after > 0) {
          void replayWsEvents(ws, ws.data.conversationId, ws.data.after).catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
        }
      },
      close(ws) {
        // 断连:消费者计数减一,若归零且回合仍在跑,宽限期后无人重连则中止(turnConsumers 内部处理)。
        turnConsumers.onDisconnect(ws.data.conversationId)
      },
      message(ws, message) {
        let body: Record<string, unknown>
        try {
          const parsed = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'))
          body = { ...parseClientMessage(parsed) }
        } catch {
          wsError(ws, 'invalid websocket message')
          return
        }
        const type = body.type
        if (type === 'ping') {
          // 应用层心跳(对齐 cc ws/handler ping/pong):前端定时发 ping 保活,避免 Bun idle 掐断长连接。
          wsSend(ws, { type: 'pong', ts: numberFrom(body.ts, 0) || undefined })
          return
        }
        if (type === 'run') {
          void handleWsRun(ws, body)
          return
        }
        if (type === 'replay') {
          const conversationId = stringOr(body.conversationId, ws.data.conversationId)
          const after = numberFrom(body.after, 0)
          ws.data.conversationId = conversationId
          void replayWsEvents(ws, conversationId, after).catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        if (type === 'interrupt') {
          const conversationId = stringOr(body.conversationId, ws.data.conversationId)
          const interrupted = turns.interrupt(conversationId)
          void (async () => {
            if (interrupted) {
              await sessions.touch(conversationId, { status: 'interrupted' })
              const record = await sessions.appendEvent(conversationId, { type: 'context_note', text: '任务已请求中断' }).catch(() => null)
              if (record) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
            }
            wsSend(ws, { type: 'interrupt_result', conversationId, interrupted })
          })().catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        if (type === 'steer') {
          // 运行中插话纠偏走同一条 WS(对齐 cc 全走一条连接):推进 steerInbox + 落 steering 事件回灌。
          const conversationId = stringOr(body.conversationId, ws.data.conversationId)
          const message = typeof body.message === 'string' ? body.message.trim() : ''
          if (!message) { wsError(ws, 'steer message required'); return }
          void (async () => {
            if (!turns.isRunning(conversationId)) {
              wsSend(ws, { type: 'steer_result', conversationId, queued: 0, running: false })
              return
            }
            const inbox = steerInboxes.get(conversationId) ?? []
            inbox.push(message)
            steerInboxes.set(conversationId, inbox)
            // submit-interrupt(对齐 cc handlePromptSubmit:hasInterruptibleToolInProgress → abort('interrupt')):
            // 总是通知循环有插话;循环自带闸,仅当可中断工具在飞时才当场切断,否则等价入队(safe-point drain)。
            interruptRequesters.get(conversationId)?.()
            const record = await sessions.appendEvent(conversationId, { type: 'steering', content: message }).catch(() => null)
            if (record) wsSend(ws, { type: 'event', seq: record.seq, ts: record.ts, event: record.event })
            wsSend(ws, { type: 'steer_result', conversationId, queued: inbox.length, running: true })
          })().catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        if (type === 'approve') {
          // 审批放行走同一条 WS(对齐 cc):复用 runApprovedTool(验签→执行→结果写回 transcript),回 approve_result。
          void (async () => {
            const payload = await runApprovedTool(body)
            if (!payload) { wsError(ws, 'tool required'); return }
            wsSend(ws, { type: 'approve_result', ...payload })
          })().catch(err => wsError(ws, err instanceof Error ? err.message : String(err)))
          return
        }
        if (type === 'reject') {
          // 审批拒绝走同一条 WS:复用 handleReject(拒绝追踪:多次拒绝后不再反复弹卡)。
          const toolName = typeof body.tool === 'string' ? body.tool.trim() : ''
          if (!toolName) { wsError(ws, 'tool required'); return }
          handleReject(toolName, body.args ?? {}, {
            workspace: workspaceFromBody(body),
            conversationId: stringOr(body.conversation_id ?? body.conversationId, ws.data.conversationId) || undefined,
            permissionMode: permissionModeFrom(body.permission_mode ?? body.permissionMode),
          })
          wsSend(ws, { type: 'reject_result', ok: true })
          return
        }
        wsError(ws, `unknown websocket message type: ${type}`)
      },
    },
  })
  // 资产下载进度 → WS 广播(事件结构见 assets/types AssetProgressEvent)。
  const unsubscribeAssetEvents = assets.onEvent(event => {
    try {
      app.publish(ASSET_WS_TOPIC, JSON.stringify(event))
    } catch {
      // server 已停/无订阅者:忽略,状态照常落 state.json。
    }
  })
  // 定时任务调度:测试环境默认不启(避免无关测试里后台起真 agent 会话);QF_SCHEDULER=0 显式关。
  const scheduledTasksAutoStart = opts.scheduledTasksAutoStart ?? (process.env.NODE_ENV !== 'test' && (opts.env ?? process.env).QF_SCHEDULER !== '0')
  if (scheduledTasksAutoStart) scheduledTasks.start()
  // 诊断遥测(task#16):开机上传心跳+上次崩溃日志到自有 dataeye(静默、脱敏、幂等;env 缺配置=禁用)。
  // fire-and-forget:任何失败都不影响启动;测试环境同 scheduler 口径不自动跑(测试显式调用)。
  if (process.env.NODE_ENV !== 'test') {
    const telemetry = createTelemetryService({ stateRoot, env: opts.env ?? process.env })
    if (telemetry.enabled) void telemetry.uploadOnBoot((opts.env ?? process.env).QF_APP_VERSION ?? '0.0.0-dev')
  }
  const stop = app.stop.bind(app)
  app.stop = (closeActiveConnections?: boolean) => {
    unsubscribeAssetEvents()
    scheduledTasks.stop()
    assets.stop()
    if (getActiveAssetManager() === assets) setActiveAssetManager(null)
    for (const subscriber of bridgeSubscribers.values()) subscriber.close()
    bridgeSubscribers.clear()
    for (const scheduler of bridgeWorkerRefreshSchedulers.values()) scheduler.cancel()
    bridgeWorkerRefreshSchedulers.clear()
    for (const stream of bridgeWorkerStreams.values()) stream.close()
    bridgeWorkerStreams.clear()
    for (const worker of bridgeWorkers.values()) worker.close()
    bridgeWorkers.clear()
    return stop(closeActiveConnections)
  }
  return app
}
