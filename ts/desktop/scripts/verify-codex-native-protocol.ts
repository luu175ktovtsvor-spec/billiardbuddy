import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const expectedRevision = '2b5bdcf67547860f2e5c5a605009a70026796b2b'
const desktopRoot = path.resolve(import.meta.dir, '..')
const repositoryRoot = path.resolve(desktopRoot, '..', '..')
const engineRoot = path.join(repositoryRoot, 'third_party', 'codex-engine')

const clientRequestMethods = [
  'initialize',
  'thread/start',
  'thread/list',
  'thread/search',
  'thread/resume',
  'thread/read',
  'thread/fork',
  'thread/unarchive',
  'thread/delete',
  'thread/name/set',
  'thread/compact/start',
  'thread/rollback',
  'thread/turns/list',
  'thread/items/list',
  'thread/settings/update',
  'config/value/write',
  'config/mcpServer/reload',
  'mcpServerStatus/list',
  'mcpServer/oauth/login',
  'skills/list',
  'skills/config/write',
  'skills/extraRoots/set',
  'hooks/list',
  'plugin/list',
  'plugin/installed',
  'plugin/read',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'plugin/install',
  'plugin/uninstall',
  'collaborationMode/list',
  'review/start',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/archive',
] as const

const serverRequestMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
] as const

function requireFile(relativePath: string): string {
  const file = path.join(engineRoot, relativePath)
  if (!existsSync(file)) {
    throw new Error(`Codex Engine 源码缺少 ${relativePath}；请执行 git submodule update --init --recursive`)
  }
  return readFileSync(file, 'utf8')
}

function requireDesktopFile(relativePath: string): string {
  const file = path.join(desktopRoot, relativePath)
  if (!existsSync(file)) throw new Error(`桌面原生协议边界缺少 ${relativePath}`)
  return readFileSync(file, 'utf8')
}

function requireRepositoryFile(relativePath: string): string {
  const file = path.join(repositoryRoot, relativePath)
  if (!existsSync(file)) throw new Error(`产品协议边界缺少 ${relativePath}`)
  return readFileSync(file, 'utf8')
}

async function gitOutput(...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', engineRoot, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`无法读取 Codex Engine Git 状态：${stderr.trim() || args.join(' ')}`)
  return stdout.trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function staticMethodCalls(source: string, operation: 'request' | 'notify'): string[] {
  const callPattern = new RegExp(`\\.${operation}(?:<[^>\\n]+>)?\\(\\s*`, 'g')
  const literalPattern = new RegExp(`\\.${operation}(?:<[^>\\n]+>)?\\(\\s*'([^']+)'`, 'g')
  const allCalls = [...source.matchAll(callPattern)]
  const literalCalls = [...source.matchAll(literalPattern)].map(match => match[1]!)
  if (allCalls.length !== literalCalls.length) {
    throw new Error(`Codex App Server ${operation} 存在非字面量方法名，拒绝绕过源码协议审计`)
  }
  return literalCalls
}

function assertExactMethods(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  const missing = [...expectedSet].filter(method => !actualSet.has(method))
  const unexpected = [...actualSet].filter(method => !expectedSet.has(method))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`${label} 与受管协议清单不一致：缺少 ${missing.join(', ') || '无'}；多出 ${unexpected.join(', ') || '无'}`)
  }
}

function assertRustMethod(protocol: string, method: string): void {
  const pattern = new RegExp(`=>\\s*"${escapeRegex(method)}"\\s*\\{`)
  if (!pattern.test(protocol)) throw new Error(`锁定 Codex Rust 协议未声明方法 ${method}`)
}

function assertContains(source: string, fragment: string, description: string): void {
  if (!source.includes(fragment)) throw new Error(`锁定 Codex Rust 协议缺少 ${description}`)
}

function assertNotContains(source: string, fragment: string, description: string): void {
  if (source.includes(fragment)) throw new Error(`产品协议边界不应包含 ${description}`)
}

async function main(): Promise<void> {
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }

  const protocol = requireFile('codex-rs/app-server-protocol/src/protocol/common.rs')
  const runtime = requireDesktopFile('electron/services/codexNativeAppServer.ts')
  const provider = requireDesktopFile('electron/services/codexNativeProvider.ts')
  const providerCredentials = requireDesktopFile('electron/services/providerCredentials.ts')
  const ipcCapabilities = requireDesktopFile('electron/ipc/capabilities.ts')
  const personalModels = requireRepositoryFile('ts/shared/product/personalModels.ts')
  const providerRegistry = requireRepositoryFile('gateway/providerRegistry.ts')
  const managedResponses = requireRepositoryFile('gateway/managedResponses.ts')
  const mainProcess = requireDesktopFile('electron/main.ts')
  const serverRequestBridge = requireDesktopFile('electron/services/nativeServerRequest.ts')

  assertExactMethods(staticMethodCalls(runtime, 'request'), clientRequestMethods, 'Electron → App Server 请求')
  assertExactMethods(staticMethodCalls(runtime, 'notify'), ['initialized'], 'Electron → App Server 通知')
  for (const method of clientRequestMethods) assertRustMethod(protocol, method)
  for (const method of serverRequestMethods) {
    assertRustMethod(protocol, method)
    if (!mainProcess.includes(`'${method}'`) && !serverRequestBridge.includes(`'${method}'`)) {
      throw new Error(`原生 server request ${method} 未被 Electron 后端明确处理`)
    }
  }

  assertContains(protocol, 'client_notification_definitions! {\n    Initialized,', 'initialized 客户端通知定义')
  assertContains(protocol, '"method": "initialized"', 'initialized 客户端通知序列化')
  assertContains(runtime, 'experimentalApi: true', '实验性 App Server 协议能力声明')
  assertContains(runtime, 'requestAttestation: false', '禁用未接入的上游 attestation 请求')
  assertContains(runtime, 'runtimeWorkspaceRoots', '受控运行工作区根目录')
  assertContains(runtime, 'sandboxPolicy', '原生沙箱策略字段')
  assertContains(runtime, 'textElements: []', '原生文本输入元素默认值')
  assertContains(runtime, "createHash('sha256')", '个人模型路由无明文凭据指纹')
  assertContains(runtime, 'async invalidateModelRoute()', '个人模型变更后的子进程能力撤销')
  assertContains(runtime, 'CODEX_NATIVE_ROUTE_CHANGE_REQUIRES_IDLE', '原生 Turn 期间的模型路由变更拦截')
  assertContains(runtime, 'async ensureThread(', '撤销后由原生 Thread Store 重新加载线程')
  assertContains(runtime, 'resumeStoredThread', '撤销后原生 thread/resume 恢复')
  assertContains(runtime, 'async startReview(', '原生代码审查入口')
  assertContains(runtime, "'review/start'", '原生代码审查协议调用')
  assertContains(runtime, "'skills/extraRoots/set'", '原生额外技能目录协议调用')
  assertContains(runtime, "'plugin/list'", '原生插件目录协议调用')
  assertContains(runtime, "marketplaceKinds: ['local', 'workspace-directory']", '产品插件目录只选择本地和工作区市场')
  assertContains(runtime, "'plugin/install'", '原生插件安装协议调用')
  assertContains(runtime, "'plugin/uninstall'", '原生插件卸载协议调用')
  assertContains(mainProcess, 'confirmNativeAgentExtensionChange', '插件与额外技能目录由 Main 确认')
  assertContains(runtime, 'nativeCollaborationSettings', '原生协作模式参数映射')
  assertContains(runtime, 'developer_instructions: null', '协作模式使用上游内置指令')
  assertContains(runtime, 'isAvailable(): boolean', 'App Server 子进程存活状态')
  assertContains(runtime, 'markUnavailable', 'App Server 异常退出标记')
  assertContains(runtime, 'onAppServerUnavailable', 'App Server 失效时释放产品交互等待')
  assertContains(runtime, 'void this.handleServerRequest', 'server request 不阻塞原生 stdout 事件流')
  assertContains(runtime, 'this.client.isAvailable()', '异常退出后的原生 Thread 重连分支')
  assertContains(mainProcess, 'await nativeAgentRuntime?.invalidateModelRoute()', '凭据写入后撤销旧原生子进程')
  assertContains(mainProcess, 'contextWindowTokens: entry.verified_context_window', '托管模型窗口来自受信 Gateway 注册表')
  assertNotContains(mainProcess, 'autoCompactTokenLimit:', 'Electron 覆盖 Core 自动压缩阈值')
  assertContains(mainProcess, 'getReadyNativeAgentThreadRuntime', '线程操作前重新接入当前原生模型路由')
  assertContains(mainProcess, 'nativeAgentResolveServerRequest', '原生 server request 回填 IPC')
  assertContains(mainProcess, 'rejectNativeAgentServerRequests', '原生子进程失效时清理交互请求')
  assertContains(serverRequestBridge, 'validateNativeServerRequestResponse', '按 source request 校验回填结果')
  assertContains(serverRequestBridge, "request.method === 'item/tool/call'", '未注册动态工具的 fail-closed 回退')
  assertContains(provider, "${prefix}.wire_api=${quoted('responses')}", '所有 App Server provider 固定使用 Responses wire API')
  assertContains(provider, 'model_context_window=${input.contextWindowTokens}', 'Provider 上下文窗口传入 Core')
  assertNotContains(provider, 'model_auto_compact_token_limit=', 'Provider 覆盖 Core 原生自动压缩阈值')
  assertContains(provider, "profile.context_limits_source !== 'user-declared'", '未声明个人模型限制不得进入 Core')
  assertContains(provider, "if (profile.protocol === 'openai-responses')", '个人 Responses Key 直连分支')
  assertContains(provider, "if (profile.protocol !== 'openai-compatible')", '未知个人协议 fail-closed')
  assertContains(provider, 'class ChatCompletionsResponsesAdapter', '个人 Chat Completions 本机转换器')
  assertContains(provider, "url.pathname !== '/v1/responses'", 'Chat 转换器对 Rust 暴露的唯一 Responses 路由')
  assertContains(provider, "personalModelEndpoint(this.profile.base_url, 'chat/completions')", 'Chat 转换器唯一上游 Chat Completions 调用')
  assertContains(ipcCapabilities, "value === 'openai-compatible' || value === 'openai-responses'", 'IPC 只接受两种个人 Key 协议')
  assertContains(ipcCapabilities, 'context_window_tokens', '个人 Key 上下文窗口配置入口')
  assertContains(ipcCapabilities, 'max_output_tokens', '个人 Key 输出预留配置入口')
  assertContains(ipcCapabilities, 'personalModelContextContract', '个人模型窗口与输出预留必须成对声明')
  assertContains(ipcCapabilities, 'auth_mode', '个人 Key 认证头配置入口')
  assertContains(personalModels, "export const PERSONAL_MODEL_PROTOCOLS = [\n  'openai-compatible',\n  'openai-responses',", '个人模型配置只声明两种正式协议')
  assertContains(personalModels, "if (rawProtocol === 'anthropic-messages') return []", '历史第三方配置只迁移丢弃，不进入原生 Agent 路由')
  assertContains(personalModels, "'legacy-unverified'", '历史个人模型限制标记为未验证')
  assertContains(personalModels, 'PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED', '新个人模型必须声明窗口与输出预留')
  assertContains(providerCredentials, "profile.context_limits_source !== 'user-declared'", '未验证个人模型路由 fail closed')
  assertContains(providerRegistry, 'DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_000_000', '托管 DeepSeek 使用已验证的一百万上下文窗口')
  assertContains(providerRegistry, 'DEEPSEEK_V4_FLASH_PROVIDER_MAX_OUTPUT_TOKENS = 384_000', '托管 DeepSeek 保留官方最大输出规格')
  assertContains(managedResponses, 'max_output_tokens: maxOutputTokens', 'Gateway 为托管请求写入受管输出上限')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v1.rs'), 'pub request_attestation: bool', '初始化 attestation 能力')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), '#[experimental("thread/start.runtimeWorkspaceRoots")]', 'thread/start 运行根目录字段')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadSettingsUpdateParams', 'thread/settings/update 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadListParams', 'thread/list 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadTurnsListParams', 'thread/turns/list 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadItemsListParams', 'thread/items/list 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadCompactStartParams', 'thread/compact/start 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadRollbackParams', 'thread/rollback 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/permissions.rs'), 'pub enum SandboxPolicy', '原生 SandboxPolicy')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/permissions.rs'), 'pub struct PermissionsRequestApprovalResponse', '原生权限申请响应')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/turn.rs'), 'text_elements: Vec<TextElement>', '原生文本输入元素')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/turn.rs'), 'pub collaboration_mode: Option<CollaborationMode>', '原生协作模式 Turn 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/collaboration_mode.rs'), 'pub struct CollaborationModeMask', '原生协作模式目录')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/review.rs'), 'pub struct ReviewStartParams', '原生代码审查参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/review.rs'), 'pub enum ReviewTarget', '原生代码审查目标')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct SkillsExtraRootsSetParams', '原生额外技能目录参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct MarketplaceAddParams', '原生插件市场添加参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct MarketplaceUpgradeParams', '原生插件市场更新参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct PluginListParams', '原生插件目录参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct PluginInstalledParams', '原生已安装插件参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct PluginInstallParams', '原生插件安装参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/plugin.rs'), 'pub struct PluginUninstallParams', '原生插件卸载参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/item.rs'), 'pub struct ToolRequestUserInputResponse', '原生用户追问响应')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/mcp.rs'), 'pub struct McpServerElicitationRequestResponse', '原生 MCP 表单响应')

  console.log(`[codex-native-protocol] ${clientRequestMethods.length} client requests, ${serverRequestMethods.length} server-request contracts, provider revocation, crash recovery and initialized notification verified against ${revision}`)
}

await main()
