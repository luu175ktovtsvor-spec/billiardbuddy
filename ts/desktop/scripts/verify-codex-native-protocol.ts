import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const expectedRevision = 'ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff'
const desktopRoot = path.resolve(import.meta.dir, '..')
const repositoryRoot = path.resolve(desktopRoot, '..', '..')
const engineRoot = path.join(repositoryRoot, 'third_party', 'codex-engine')

const clientRequestMethods = [
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/fork',
  'thread/settings/update',
  'config/value/write',
  'config/mcpServer/reload',
  'mcpServerStatus/list',
  'mcpServer/oauth/login',
  'skills/list',
  'skills/config/write',
  'hooks/list',
  'collaborationMode/list',
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

async function main(): Promise<void> {
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }

  const protocol = requireFile('codex-rs/app-server-protocol/src/protocol/common.rs')
  const runtime = requireDesktopFile('electron/services/codexNativeAppServer.ts')
  const provider = requireDesktopFile('electron/services/codexNativeProvider.ts')
  const ipcCapabilities = requireDesktopFile('electron/ipc/capabilities.ts')
  const personalModels = requireRepositoryFile('ts/shared/product/personalModels.ts')
  const mainProcess = requireDesktopFile('electron/main.ts')
  const fallback = requireDesktopFile('electron/services/nativeServerRequestFallback.ts')

  assertExactMethods(staticMethodCalls(runtime, 'request'), clientRequestMethods, 'Electron → App Server 请求')
  assertExactMethods(staticMethodCalls(runtime, 'notify'), ['initialized'], 'Electron → App Server 通知')
  for (const method of clientRequestMethods) assertRustMethod(protocol, method)
  for (const method of serverRequestMethods) {
    assertRustMethod(protocol, method)
    if (!mainProcess.includes(`'${method}'`) && !fallback.includes(`'${method}'`)) {
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
  assertContains(runtime, 'isAvailable(): boolean', 'App Server 子进程存活状态')
  assertContains(runtime, 'markUnavailable', 'App Server 异常退出标记')
  assertContains(runtime, 'this.client.isAvailable()', '异常退出后的原生 Thread 重连分支')
  assertContains(mainProcess, 'await nativeAgentRuntime?.invalidateModelRoute()', '凭据写入后撤销旧原生子进程')
  assertContains(mainProcess, 'getReadyNativeAgentThreadRuntime', '线程操作前重新接入当前原生模型路由')
  assertContains(provider, "${prefix}.wire_api=${quoted('responses')}", '所有 App Server provider 固定使用 Responses wire API')
  assertContains(provider, "if (profile.protocol === 'openai-responses')", '个人 Responses Key 直连分支')
  assertContains(provider, "if (profile.protocol !== 'openai-compatible')", '未知个人协议 fail-closed')
  assertContains(provider, 'class ChatCompletionsResponsesAdapter', '个人 Chat Completions 本机转换器')
  assertContains(provider, "url.pathname !== '/v1/responses'", 'Chat 转换器对 Rust 暴露的唯一 Responses 路由')
  assertContains(provider, "personalModelEndpoint(this.profile.base_url, 'chat/completions')", 'Chat 转换器唯一上游 Chat Completions 调用')
  assertContains(ipcCapabilities, "value === 'openai-compatible' || value === 'openai-responses'", 'IPC 只接受两种个人 Key 协议')
  assertContains(personalModels, "export const PERSONAL_MODEL_PROTOCOLS = [\n  'openai-compatible',\n  'openai-responses',", '个人模型配置只声明两种正式协议')
  assertContains(personalModels, "if (rawProtocol === 'anthropic-messages') return []", '历史第三方配置只迁移丢弃，不进入原生 Agent 路由')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v1.rs'), 'pub request_attestation: bool', '初始化 attestation 能力')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), '#[experimental("thread/start.runtimeWorkspaceRoots")]', 'thread/start 运行根目录字段')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/thread.rs'), 'pub struct ThreadSettingsUpdateParams', 'thread/settings/update 参数')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/permissions.rs'), 'pub enum SandboxPolicy', '原生 SandboxPolicy')
  assertContains(requireFile('codex-rs/app-server-protocol/src/protocol/v2/turn.rs'), 'text_elements: Vec<TextElement>', '原生文本输入元素')

  console.log(`[codex-native-protocol] ${clientRequestMethods.length} client requests, ${serverRequestMethods.length} server-request contracts, provider revocation, crash recovery and initialized notification verified against ${revision}`)
}

await main()
