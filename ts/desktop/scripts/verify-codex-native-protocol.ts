import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CODEX_ENGINE_PRODUCT_PATCHES,
  CODEX_ENGINE_SOURCE_REVISION,
} from '../../shared/product/codexEngineContract'

const expectedRevision = CODEX_ENGINE_SOURCE_REVISION
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
  'thread/goal/get',
  'thread/goal/set',
  'thread/goal/clear',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/backgroundTerminals/clean',
  'thread/settings/update',
  'windowsSandbox/readiness',
  'windowsSandbox/setupStart',
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
  'externalAgentConfig/detect',
  'externalAgentConfig/import',
  'review/start',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'thread/archive',
] as const

/**
 * The upstream App Server has a wider client protocol than BilliardBuddy's
 * current desktop backend.  This is an explicit product-boundary review, not
 * an allow-by-omission list: a new upstream request makes this verifier fail
 * until it is either connected through a typed Main-process capability or
 * classified here with a concrete reason.
 *
 * Native Agent execution is not in this list. Threads, turns, context,
 * sandboxed tools, approvals, recovery, MCP, Skills, Hooks, review and
 * collaboration are all driven by the direct requests above and source
 * notifications.  These entries are controls around an OpenAI account/cloud
 * product, unsafe raw IPC bypasses, source-internal migration/debug paths, or
 * UI surfaces deliberately deferred until the product frontend is rebuilt.
 */
const reviewedNonExposedClientRequestMethods = {
  /** Not part of a BYOK/managed-model BilliardBuddy account. */
  upstreamOpenAiAccountAndCloud: [
    'account/login/cancel',
    'account/login/start',
    'account/logout',
    'account/rateLimitResetCredit/consume',
    'account/rateLimits/read',
    'account/read',
    'account/sendAddCreditsNudgeEmail',
    'account/usage/read',
    'account/workspaceMessages/read',
    'app/installed',
    'app/list',
    'app/read',
    'feedback/upload',
    'getAuthStatus',
    'getConversationSummary',
    'gitDiffToRemote',
  ],
  /**
   * Must never become generic Renderer IPC: Rust turns invoke equivalent
   * sandboxed tools under native approval policy instead.
   */
  rawProcessAndFilesystemBypasses: [
    'command/exec',
    'command/exec/resize',
    'command/exec/terminate',
    'command/exec/write',
    'fs/copy',
    'fs/createDirectory',
    'fs/getMetadata',
    'fs/readDirectory',
    'fs/readFile',
    'fs/remove',
    'fs/unwatch',
    'fs/watch',
    'fs/writeFile',
    'fuzzyFileSearch',
    'fuzzyFileSearch/sessionStart',
    'fuzzyFileSearch/sessionStop',
    'fuzzyFileSearch/sessionUpdate',
    'process/kill',
    'process/resizePty',
    'process/spawn',
    'process/writeStdin',
    'thread/shellCommand',
  ],
  /** Source diagnostics, import helpers and experimental switches, not product APIs. */
  sourceOnlyConfigurationAndMigration: [
    'config/batchWrite',
    'config/read',
    'configRequirements/read',
    'experimentalFeature/enablement/set',
    'experimentalFeature/list',
    'externalAgentConfig/import/readHistories',
    'externalAgentConfig/import/recordHistory',
    'mock/experimentalMethod',
  ],
  /**
   * Requires a separate product pairing/remote-environment policy; it cannot
   * be inferred from local workspace permission or an arbitrary user key.
   */
  remoteEnvironmentAndDeviceControl: [
    'environment/add',
    'environment/info',
    'environment/status',
    'remoteControl/client/list',
    'remoteControl/client/revoke',
    'remoteControl/disable',
    'remoteControl/enable',
    'remoteControl/pairing/start',
    'remoteControl/pairing/status',
    'remoteControl/status/read',
  ],
  /**
   * Native backend methods whose product UI/typed IPC is intentionally later:
   * model picker, direct resource explorer, plugin sharing, sections/memory,
   * realtime voice and guardian controls.  They remain source-backed future
   * work, rather than being misrepresented as already exposed product APIs.
   */
  deferredProductSurfaces: [
    'mcpServer/resource/read',
    'mcpServer/tool/call',
    'memory/reset',
    'model/list',
    'modelProvider/capabilities/read',
    'permissionProfile/list',
    'plugin/search',
    'plugin/share/checkout',
    'plugin/share/delete',
    'plugin/share/list',
    'plugin/share/save',
    'plugin/share/updateTargets',
    'plugin/skill/read',
    'thread/approveGuardianDeniedAction',
    'thread/decrement_elicitation',
    'thread/increment_elicitation',
    'thread/inject_items',
    'thread/loaded/list',
    'thread/memoryMode/set',
    'thread/metadata/update',
    'thread/realtime/appendAudio',
    'thread/realtime/appendSpeech',
    'thread/realtime/appendText',
    'thread/realtime/listVoices',
    'thread/realtime/start',
    'thread/realtime/stop',
    'thread/searchOccurrences',
    'thread/section/move',
    'thread/unsubscribe',
    'threadSection/create',
    'threadSection/delete',
    'threadSection/list',
    'threadSection/update',
  ],
} as const

const reviewedNonExposedMethods = Object.values(reviewedNonExposedClientRequestMethods).flat()

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
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function requireDesktopFile(relativePath: string): string {
  const file = path.join(desktopRoot, relativePath)
  if (!existsSync(file)) throw new Error(`桌面原生协议边界缺少 ${relativePath}`)
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

function requireRepositoryFile(relativePath: string): string {
  const file = path.join(repositoryRoot, relativePath)
  if (!existsSync(file)) throw new Error(`产品协议边界缺少 ${relativePath}`)
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
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

function assertUniqueMethods(methods: readonly string[], label: string): void {
  const duplicates = methods.filter((method, index) => methods.indexOf(method) !== index)
  if (duplicates.length > 0) {
    throw new Error(`${label} 存在重复条目：${[...new Set(duplicates)].join(', ')}`)
  }
}

function sourceClientRequestMethods(protocol: string): string[] {
  const start = protocol.indexOf('client_request_definitions! {')
  const end = protocol.indexOf('/// Generates an `enum ServerRequest`', start)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('无法定位锁定 Codex Rust ClientRequest 协议定义')
  }
  return [...protocol.slice(start, end).matchAll(/=>\s*"([^"]+)"\s*\{/g)].map(match => match[1]!)
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

function sourceSection(source: string, startMarker: string, endMarker: string, description: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (start < 0 || end < 0 || end <= start) throw new Error(`无法定位源码区段：${description}`)
  return source.slice(start, end)
}

async function main(): Promise<void> {
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }

  const protocol = requireFile('codex-rs/app-server-protocol/src/protocol/common.rs')
  const runtime = requireDesktopFile('electron/services/codexNativeAppServer.ts')
  const engineContract = requireRepositoryFile('ts/shared/product/codexEngineContract.ts')
  const provider = requireDesktopFile('electron/services/codexNativeProvider.ts')
  const providerCredentials = requireDesktopFile('electron/services/providerCredentials.ts')
  const ipcCapabilities = requireDesktopFile('electron/ipc/capabilities.ts')
  const personalModelDiscovery = requireDesktopFile('electron/services/personalModelDiscovery.ts')
  const personalModels = requireRepositoryFile('ts/shared/product/personalModels.ts')
  const personalModelProviderCatalog = requireRepositoryFile('ts/shared/product/personalModelProviderCatalog.ts')
  const providerRegistry = requireRepositoryFile('gateway/providerRegistry.ts')
  const managedResponses = requireRepositoryFile('gateway/managedResponses.ts')
  const featureDefinitions = requireFile('codex-rs/features/src/lib.rs')
  const engineBuildWorkflow = requireRepositoryFile('.github/workflows/codex-engine-build.yml')
  const mainProcess = requireDesktopFile('electron/main.ts')
  const credentialStore = requireDesktopFile('electron/services/keychain.ts')
  const serverRequestBridge = requireDesktopFile('electron/services/nativeServerRequest.ts')
  const engineStaging = requireDesktopFile('scripts/stage-codex-engine.ts')

  assertUniqueMethods(clientRequestMethods, '已接入 App Server client request')
  assertUniqueMethods(reviewedNonExposedMethods, '已审计但未暴露的 App Server client request')
  assertExactMethods(
    sourceClientRequestMethods(protocol),
    [...clientRequestMethods, ...reviewedNonExposedMethods],
    '锁定 Codex Rust ClientRequest 全量协议审计',
  )
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
  assertContains(runtime, 'hasVerifiedNativeEngineManifest(', '原生二进制的受管补丁清单校验')
  assertContains(runtime, 'CODEX_ENGINE_PRODUCT_PATCHES', '原生二进制的受管补丁合同')
  assertContains(runtime, 'if (!await hasVerifiedNativeEngineManifest(', '未验证内核的 fail-closed 启动门')
  assertContains(requireDesktopFile('scripts/verify-codex-engine-source.ts'), '--apply-product-patches', 'CI 按产品补丁合同应用内核改动')
  assertContains(engineStaging, '--prebuilt-binary', '可从 GitHub 构建产物封装受管引擎')
  assertContains(engineStaging, 'assertPinnedSource()', '预构建引擎仍核对锁定源码版本')
  assertContains(engineBuildWorkflow, '--prebuilt-binary', 'GitHub 内核构建产物封装为受管运行时')
  assertContains(engineBuildWorkflow, 'runtime-assets/binaries/', 'GitHub 保存完整可校验引擎运行时')
  assertContains(engineContract, 'CODEX_ENGINE_MANIFEST_SCHEMA = 4', '受管补丁清单版本')
  for (const patch of CODEX_ENGINE_PRODUCT_PATCHES) {
    assertContains(engineContract, `file: '${patch.file}'`, `受管补丁 ${patch.file}`)
    assertContains(engineContract, `sha256: '${patch.sha256}'`, `受管补丁 ${patch.file} 的 SHA-256`)
  }
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
  assertContains(runtime, "'thread/goal/get'", '原生 Thread Goal 查询协议调用')
  assertContains(runtime, "'thread/goal/set'", '原生 Thread Goal 更新协议调用')
  assertContains(runtime, "'thread/goal/clear'", '原生 Thread Goal 清除协议调用')
  assertContains(runtime, "'thread/backgroundTerminals/list'", '原生后台终端查询协议调用')
  assertContains(runtime, "'thread/backgroundTerminals/terminate'", '原生后台终端停止协议调用')
  assertContains(runtime, "'thread/backgroundTerminals/clean'", '原生后台终端批量停止协议调用')
  assertContains(runtime, "'windowsSandbox/readiness'", '原生 Windows Sandbox 状态协议调用')
  assertContains(runtime, "'windowsSandbox/setupStart'", '原生 Windows Sandbox 初始化协议调用')
  assertContains(runtime, 'windowsSandbox/setupCompleted', '原生 Windows Sandbox 完成通知处理')
  assertContains(runtime, 'CODEX_NATIVE_WINDOWS_SANDBOX_SETUP_IN_PROGRESS', '初始化期间阻止新 Turn')
  assertContains(mainProcess, 'confirmNativeAgentWindowsSandboxSetup', 'Windows Sandbox 由 Main 明确确认')
  assertContains(mainProcess, 'nativeWindowsSandboxSetupOwnerId', 'Windows Sandbox 全局通知绑定发起窗口')
  assertContains(ipcCapabilities, 'nativeAgentWindowsSandboxSetupStart', 'Windows Sandbox 初始化 IPC 校验')
  assertContains(ipcCapabilities, 'nativeAgentWindowsSandboxReadiness', 'Windows Sandbox 状态 IPC 校验')
  assertContains(engineStaging, 'codex-windows-sandbox-setup.exe', 'Windows Sandbox setup 辅助程序随引擎封装')
  assertContains(engineStaging, 'codex-command-runner.exe', 'Windows Sandbox command-runner 辅助程序随引擎封装')
  assertContains(engineBuildWorkflow, '--package codex-windows-sandbox', 'GitHub 构建原生 Windows Sandbox 辅助程序')
  assertContains(engineBuildWorkflow, '--prebuilt-windows-sandbox-setup', 'GitHub 将 Windows Sandbox setup 辅助程序交给封装器')
  assertNotContains(runtime, "'thread/shellCommand'", '绕过沙箱的 App Server shellCommand 接口')
  assertContains(protocol, '#[experimental("thread/backgroundTerminals/list")]', '后台终端查询的上游实验性标记')
  assertContains(protocol, 'ThreadGoalUpdated => "thread/goal/updated"', '原生 Thread Goal 更新通知')
  assertContains(protocol, 'ThreadGoalCleared => "thread/goal/cleared"', '原生 Thread Goal 清除通知')
  assertContains(featureDefinitions, 'id: Feature::Goals,\n        key: "goals",\n        stage: Stage::Stable,\n        default_enabled: true,', '原生 Thread Goal 默认启用')
  assertContains(mainProcess, 'confirmNativeAgentBackgroundTerminalChange', '后台终端停止由 Main 确认')
  assertContains(ipcCapabilities, 'nativeAgentSetThreadGoal', 'Thread Goal 的受限 IPC 校验')
  assertContains(ipcCapabilities, 'nativeAgentBackgroundTerminalReference', '后台终端进程标识受限 IPC 校验')
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
  assertContains(runtime, "'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'USER'", 'macOS 原生工具的 Core 环境白名单')
  assertContains(runtime, "'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'", 'Windows 原生工具的用户目录环境白名单')
  assertContains(runtime, "'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData'", 'Windows 原生工具的位置环境白名单')
  assertContains(runtime, 'void this.handleServerRequest', 'server request 不阻塞原生 stdout 事件流')
  assertContains(runtime, 'this.client.isAvailable()', '异常退出后的原生 Thread 重连分支')
  assertContains(mainProcess, 'await nativeAgentRuntime?.invalidateModelRoute()', '凭据写入后撤销旧原生子进程')
  assertNotContains(mainProcess, 'autoCompactTokenLimit:', 'Electron 覆盖 Core 自动压缩阈值')
  assertContains(mainProcess, 'getReadyNativeAgentThreadRuntime', '线程操作前重新接入当前原生模型路由')
  assertContains(mainProcess, 'nativeAgentResolveServerRequest', '原生 server request 回填 IPC')
  assertContains(mainProcess, 'rejectNativeAgentServerRequests', '原生子进程失效时清理交互请求')
  assertContains(serverRequestBridge, 'validateNativeServerRequestResponse', '按 source request 校验回填结果')
  assertContains(serverRequestBridge, "request.method === 'item/tool/call'", '未注册动态工具的 fail-closed 回退')
  assertContains(provider, "${prefix}.wire_api=${quoted('responses')}", '所有 App Server provider 固定使用 Responses wire API')
  assertContains(provider, "'features.image_generation=false'", 'Codex 托管生图不会越过 BilliardBuddy 独立生图工作台')
  assertNotContains(provider, "'web_search=\"disabled\"'", '已验证的原生网页搜索被全局禁用')
  assertContains(provider, "'shell_environment_policy.ignore_default_excludes=false'", 'Core shell 子进程必须排除注入的 Key、Secret 与 Token')
  assertNotContains(provider, 'model_context_window=', '产品覆盖 Core 模型上下文窗口')
  assertNotContains(provider, 'model_auto_compact_token_limit=', 'Provider 覆盖 Core 原生自动压缩阈值')
  assertNotContains(provider, 'CODEX_NATIVE_PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED', '个人 Key 被产品容量契约拦截')
  assertContains(provider, "if (profile.protocol === 'openai-responses')", '个人 Responses 本机凭据桥分支')
  assertContains(provider, "if (profile.protocol !== 'openai-compatible')", '未知个人协议 fail-closed')
  assertContains(provider, 'class ResponsesCredentialAdapter', '所有 Responses 路线共用本机凭据桥')
  assertContains(provider, "failurePrefix: 'CODEX_PERSONAL_RESPONSES_ADAPTER'", '个人 Responses 凭据桥')
  assertContains(provider, "personalModelEndpoint(profile.base_url, 'responses')", '个人 Responses 凭据桥唯一上游调用')
  assertContains(provider, "const tokenEnv = 'BB_CODEX_PERSONAL_RESPONSES_ADAPTER_TOKEN'", '个人 Responses 只向 Rust 注入本机能力令牌')
  assertNotContains(provider, 'BB_CODEX_PERSONAL_RESPONSES_KEY', '个人 Responses 原始 Key 注入 Rust')
  assertContains(provider, "redirect: 'error'", '凭据桥拒绝上游重定向')
  assertContains(provider, 'class ChatCompletionsResponsesAdapter', '个人 Chat Completions 本机转换器')
  assertContains(provider, "url.pathname !== '/v1/responses'", 'Chat 转换器对 Rust 暴露的唯一 Responses 路由')
  assertContains(provider, "personalModelEndpoint(this.profile.base_url, 'chat/completions')", 'Chat 转换器唯一上游 Chat Completions 调用')
  assertContains(ipcCapabilities, "value === 'openai-compatible' || value === 'openai-responses'", 'IPC 只接受两种个人 Key 协议')
  assertNotContains(ipcCapabilities, 'context_window_tokens', '个人 Key 上下文窗口填写入口')
  assertNotContains(ipcCapabilities, 'max_output_tokens', '个人 Key 最大输出填写入口')
  assertNotContains(ipcCapabilities, 'catalog_entry_id', '个人 Key 模型容量目录入口')
  assertContains(ipcCapabilities, 'modelConfigurationProviderPresets', '个人 Key 供应商预置 IPC')
  assertContains(ipcCapabilities, 'modelConfigurationOpenProviderPortal', '个人 Key 官方申请入口 IPC')
  assertContains(ipcCapabilities, 'modelConfigurationDiscover', '个人 Key 模型发现 IPC')
  assertContains(ipcCapabilities, 'modelConfigurationDiscoverPreset', '供应商预设模型发现 IPC')
  assertContains(ipcCapabilities, 'modelConfigurationSavePreset', '供应商预设模型保存 IPC')
  assertContains(ipcCapabilities, 'auth_mode', '个人 Key 认证头配置入口')
  assertContains(personalModels, "export const PERSONAL_MODEL_PROTOCOLS = [\n  'openai-compatible',\n  'openai-responses',", '个人模型配置只声明两种正式协议')
  assertContains(personalModels, 'PersonalModelProviderPresetSelectionInput', '供应商与 Coding Plan 的简化配置契约')
  assertContains(personalModels, 'provider_preset_id', '个人模型保留所选供应商或套餐来源')
  assertNotContains(personalModels, 'PERSONAL_MODEL_CONTEXT_CONTRACT_REQUIRED', '个人模型容量必填限制')
  assertNotContains(personalModels, 'context_window_tokens', '个人模型上下文容量配置')
  assertNotContains(personalModels, 'max_output_tokens', '个人模型最大输出配置')
  assertNotContains(personalModels, 'supports_tool_calls', '个人模型能力开关')
  assertNotContains(providerCredentials, 'PersonalModelCapability', '个人模型能力路由')
  assertNotContains(provider, 'profile.supports_', 'Chat 转换器依赖产品模型能力开关')
  assertContains(personalModelProviderCatalog, "id: 'deepseek'", 'DeepSeek 官方供应商预置')
  assertContains(personalModelProviderCatalog, "id: 'openai'", 'OpenAI 官方供应商预置')
  assertContains(personalModelProviderCatalog, "id: 'kimi-api'", 'Kimi 官方供应商预置')
  assertContains(personalModelProviderCatalog, "id: 'qianfan-coding-plan'", '千帆 Coding Plan 预置')
  assertContains(personalModelProviderCatalog, "id: 'minimax-token-plan'", 'MiniMax Token Plan 预置')
  assertContains(personalModelProviderCatalog, "id: 'openrouter'", 'OpenRouter 聚合供应商预置')
  assertContains(personalModelProviderCatalog, 'api_key_url:', '供应商预置提供官方 Key 申请入口')
  assertContains(personalModelProviderCatalog, 'supported_protocols:', '供应商预置声明受支持的用户 Key 协议')
  assertContains(personalModelProviderCatalog, 'is_coding_plan:', '供应商预置区分普通 API 和 Coding Plan')
  assertContains(personalModelProviderCatalog, 'requires_provider_compatibility_confirmation:', '受限 Coding Plan 必须声明兼容性确认')
  assertContains(personalModelProviderCatalog, "model_discovery: 'openai-compatible'", '供应商预置声明自动模型发现路径')
  assertNotContains(personalModelProviderCatalog, 'catalog_entries:', '供应商预置夹带模型容量目录')
  assertContains(personalModelProviderCatalog, 'PERSONAL_MODEL_PROVIDER_SETUP_CATALOG_CORRUPT', '供应商预置目录必须校验唯一性和安全链接')
  assertContains(personalModelDiscovery, "redirect: 'error'", '模型发现不向重定向泄露用户 Key')
  assertContains(personalModelDiscovery, 'modelDiscoveryEndpoints', '模型发现兼容 Coding Plan 的同源备用路径')
  assertContains(personalModelDiscovery, 'models: modelIds.map(id => ({ id }))', '模型发现只返回上游可用模型 ID')
  assertContains(personalModelDiscovery, 'PERSONAL_MODEL_DISCOVERY_AUTH_FAILED', '模型发现明确反馈 Key 或权限错误')
  assertContains(personalModelDiscovery, 'PERSONAL_MODEL_DISCOVERY_ENDPOINT_UNSUPPORTED', '模型发现明确反馈不支持 models 接口')
  assertContains(personalModelDiscovery, 'PERSONAL_MODEL_DISCOVERY_TIMEOUT', '模型发现明确反馈超时')
  assertContains(personalModelDiscovery, 'PERSONAL_MODEL_DISCOVERY_RATE_LIMITED', '模型发现明确反馈限流')
  assertContains(personalModelDiscovery, 'PERSONAL_MODEL_DISCOVERY_INVALID_RESPONSE', '模型发现明确反馈无效响应')
  assertContains(providerCredentials, 'discoverPreset(', '预设模型发现由 Main 解析路由')
  assertContains(providerCredentials, 'savePreset(', '预设模型保存由 Main 解析路由')
  assertContains(providerCredentials, 'PERSONAL_MODEL_PROVIDER_COMPATIBILITY_CONFIRMATION_REQUIRED', '受限 Coding Plan 需确认兼容性')
  assertNotContains(providerCredentials, 'PERSONAL_MODEL_PROVIDER_MODEL_CONTRACT_REQUIRED', '未知模型要求用户填写容量合同')
  assertContains(providerCredentials, 'providerPresets(): readonly PersonalModelProviderPreset[]', '供应商预置只从主进程安全返回')
  assertContains(providerCredentials, "PERSONAL_MODEL_PROVIDER_PRESET_UNAVAILABLE", '未知供应商预置 fail-closed')
  assertContains(mainProcess, 'modelConfigurationProviderPresets', '主进程提供个人 Key 供应商预置')
  assertContains(mainProcess, 'modelConfigurationOpenProviderPortal', '主进程处理官方申请入口')
  assertContains(mainProcess, 'modelConfigurationDiscoverPreset', '主进程处理预设模型发现')
  assertContains(mainProcess, 'modelConfigurationSavePreset', '主进程处理预设模型保存')
  assertContains(mainProcess, 'openExternalUrl(preset.api_key_url)', '官方申请入口只打开受信供应商目录链接')
  assertNotContains(providerRegistry, 'verified_context_window', '平台模型容量契约干预 Core')
  assertNotContains(providerRegistry, 'managed_max_output_tokens', '平台模型最大输出契约干预 Core')
  assertNotContains(managedResponses, 'max_output_tokens: maxOutputTokens', 'Gateway 改写 Core 的输出上限')
  assertContains(credentialStore, 'new SecureSessionStore(join(userDataPath, name), safeStorage, platform)', '用户自带 Key 使用 Electron 安全存储')
  assertContains(credentialStore, 'class EphemeralCredentialStore', '自动安装会话有进程内存储实现')
  assertContains(credentialStore, 'function retireInstallationSessionArtifacts(', '旧安装会话有无系统凭据访问的清理实现')
  assertContains(mainProcess, 'retireInstallationSessionArtifacts(process.platform, userDataPath)', '启动时清理旧安装会话持久化')
  assertContains(mainProcess, 'new EphemeralCredentialStore()', '自动安装会话不触发系统凭据弹窗')
  assertContains(mainProcess, "'provider-credentials', safeStorage", '用户自带 Key 继续保存在系统安全存储')
  const electronStartup = sourceSection(mainProcess, 'app.whenReady().then(async () => {', "app.on('window-all-closed'", 'Electron 启动链')
  assertNotContains(electronStartup, 'getProviderCredentialService()', '普通启动读取用户自带 Key')
  assertNotContains(electronStartup, "'provider-credentials'", '普通启动访问用户自带 Key 凭据存储')
  const installationSessionBootstrap = sourceSection(mainProcess, 'function getInstallationSessionManager() {', '/** Main is the only desktop process allowed to read user-owned provider keys. */', '安装会话启动边界')
  assertNotContains(installationSessionBootstrap, 'createCredentialStore(', '自动安装会话构造系统凭据存储')
  assertNotContains(installationSessionBootstrap, 'safeStorage', '自动安装会话接触 Electron 系统凭据存储')
  assertContains(credentialStore, "backend === 'basic_text' || backend === 'unknown'", 'Linux 无密钥服务时拒绝明文凭据后端')
  assertContains(credentialStore, 'class MigratingCredentialStore', 'macOS 旧凭据迁移边界')
  assertContains(credentialStore, 'this.current.save(legacyValue)', '旧 macOS 凭据先写入系统安全存储')
  assertContains(credentialStore, 'if (verified !== legacyValue)', '旧 macOS 凭据迁移后校验解密结果')
  assertContains(credentialStore, "readdirSync(legacyDir).some(name => name.endsWith('.enc'))", '共享旧主密钥仅在全部旧密文消失后删除')
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
  assertContains(requireFile('codex-rs/protocol/src/shell_environment.rs'), 'EnvironmentVariablePattern::new_case_insensitive("*KEY*")', 'Core shell 默认 Key 排除规则')
  assertContains(requireFile('codex-rs/protocol/src/shell_environment.rs'), 'EnvironmentVariablePattern::new_case_insensitive("*SECRET*")', 'Core shell默认 Secret 排除规则')
  assertContains(requireFile('codex-rs/protocol/src/shell_environment.rs'), 'EnvironmentVariablePattern::new_case_insensitive("*TOKEN*")', 'Core shell默认 Token 排除规则')
  assertContains(requireFile('codex-rs/protocol/src/shell_environment.rs'), '"PATH", "SHELL", "TMPDIR", "TEMP", "TMP", "HOME"', 'Core Unix 标准工具环境定义')
  assertContains(requireFile('codex-rs/protocol/src/shell_environment.rs'), '"USERPROFILE",\n    "HOMEDRIVE",\n    "HOMEPATH"', 'Core Windows 用户目录环境定义')

  console.log(`[codex-native-protocol] ${clientRequestMethods.length} direct client requests, ${reviewedNonExposedMethods.length} reviewed non-exposed source requests, ${serverRequestMethods.length} server-request contracts, provider revocation, crash recovery and initialized notification verified against ${revision}`)
}

await main()
