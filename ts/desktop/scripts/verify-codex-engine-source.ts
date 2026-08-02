import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const expectedRevision = '2b5bdcf67547860f2e5c5a605009a70026796b2b'
const repositoryRoot = path.resolve(import.meta.dir, '../../..')
const engineRoot = path.join(repositoryRoot, 'third_party', 'codex-engine')
function requireFile(relativePath: string): string {
  const file = path.join(engineRoot, relativePath)
  if (!existsSync(file)) throw new Error(`Codex Engine 源码缺少 ${relativePath}；请执行 git submodule update --init --recursive`)
  return readFileSync(file, 'utf8')
}

function assertContains(source: string, fragment: string, description: string): void {
  if (!source.includes(fragment)) throw new Error(`Codex Engine 源码缺少 ${description}`)
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

async function main(): Promise<void> {
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }

  const license = requireFile('LICENSE')
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    throw new Error('Codex Engine 缺少 Apache-2.0 LICENSE 文本')
  }
  const notice = requireFile('NOTICE')
  if (!notice.includes('OpenAI Codex')) throw new Error('Codex Engine NOTICE 未包含上游归属')

  const appServerManifest = requireFile('codex-rs/app-server/Cargo.toml')
  if (!/^name = "codex-app-server"$/m.test(appServerManifest)) {
    throw new Error('Codex Engine 源码缺少 codex-app-server 构建入口')
  }
  for (const dependency of [
    'codex-core',
    'codex-exec-server',
    'codex-sandboxing',
    'codex-thread-store',
    'codex-tools',
    'codex-skills',
    'codex-hooks',
    'codex-mcp',
  ]) {
    assertContains(appServerManifest, `${dependency} = { workspace = true }`, `App Server 的 ${dependency} Rust 依赖`)
  }

  const appServerMain = requireFile('codex-rs/app-server/src/main.rs')
  const appServerRuntime = requireFile('codex-rs/app-server/src/lib.rs')
  const coreRoot = requireFile('codex-rs/core/src/lib.rs')
  const coreConfig = requireFile('codex-rs/core/src/config/mod.rs')
  const coreSession = requireFile('codex-rs/core/src/session/mod.rs')
  const coreTurn = requireFile('codex-rs/core/src/session/turn.rs')
  const modelInfo = requireFile('codex-rs/protocol/src/openai_models.rs')
  const toolRouter = requireFile('codex-rs/core/src/tools/router.rs')
  const arg0Dispatch = requireFile('codex-rs/arg0/src/lib.rs')

  assertContains(appServerMain, 'arg0_dispatch_or_else', 'App Server 的本地 sandbox helper 分派入口')
  assertContains(appServerRuntime, 'ExecServerRuntimePaths::from_optional_paths(', 'App Server 的本地 Exec Server 运行路径')
  assertContains(appServerRuntime, 'EnvironmentManager::from_codex_home(', 'App Server 的本地执行环境管理器')
  assertContains(appServerRuntime, 'MessageProcessor::new(MessageProcessorArgs', 'App Server 的 JSON-RPC 消息处理器')
  assertContains(coreRoot, 'pub mod context;', 'Core 上下文模块')
  assertContains(coreRoot, 'pub mod exec;', 'Core 执行模块')
  assertContains(coreRoot, 'pub mod sandboxing;', 'Core 沙箱模块')
  assertContains(coreRoot, 'pub use thread_manager::ThreadManager;', 'Core Thread Manager')
  assertContains(coreRoot, 'pub use mcp::McpManager;', 'Core MCP 管理器')
  assertContains(coreRoot, 'pub(crate) use skills::SkillsService;', 'Core Skills 服务')
  assertContains(coreRoot, 'pub(crate) mod agents_md;', 'Core 项目 AGENTS.md 加载器')
  assertContains(coreSession, 'use crate::context_manager::ContextManager;', 'Core Context Manager 连接')
  assertContains(coreSession, 'use crate::tools::sandboxing::ApprovalStore;', 'Core 原生审批存储')
  assertContains(coreTurn, 'pub(crate) async fn run_turn(', 'Core Agent Turn 循环')
  assertContains(toolRouter, 'pub struct ToolRouter', 'Core Tool Router')
  assertContains(arg0Dispatch, 'CODEX_ARG0_EXEC_HELPER_ARG1', '本地进程执行 helper')
  assertContains(arg0Dispatch, 'CODEX_FS_HELPER_ARG1', '本地文件系统 helper')
  assertContains(coreConfig, 'pub model_context_window: Option<i64>', 'Core 模型上下文窗口配置')
  assertContains(coreConfig, 'pub model_auto_compact_token_limit: Option<i64>', 'Core 自动压缩阈值配置')
  assertContains(modelInfo, 'from `context_window` (90%).', 'Core 未配置阈值时的原生自动压缩默认值')
  assertContains(modelInfo, '.map(|context_window| (context_window * 9) / 10);', 'Core 原生自动压缩阈值算法')

  const providerInfo = requireFile('codex-rs/model-provider-info/src/lib.rs')
  if (!providerInfo.includes('pub enum WireApi') || !providerInfo.includes('Responses')) {
    throw new Error('Codex Engine 模型协议基线与预期不一致')
  }
  if (!providerInfo.includes('CHAT_WIRE_API_REMOVED_ERROR')) {
    throw new Error('Codex Engine 未明确标记 Chat wire API 限制；模型桥设计需要重新复核')
  }
  assertContains(providerInfo, 'self.is_openai() || is_azure_responses_provider(&self.name, self.base_url.as_deref())', 'Core 远程压缩 Provider 限定')

  console.log(`[codex-engine] source lock passed: ${revision}`)
  console.log('[codex-engine] Rust App Server/Core/Thread/Context/Tool/Sandbox/Exec composition, Apache-2.0 NOTICE, the Responses-only provider baseline and native 90% automatic-compaction default verified; Chat must enter through the BilliardBuddy Responses bridge.')
}

await main()
