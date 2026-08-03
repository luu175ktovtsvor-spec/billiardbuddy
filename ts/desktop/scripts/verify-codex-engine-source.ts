import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CODEX_ENGINE_PRODUCT_PATCHES,
  CODEX_ENGINE_SOURCE_REVISION,
} from '../../shared/product/codexEngineContract'

const expectedRevision = CODEX_ENGINE_SOURCE_REVISION
const repositoryRoot = path.resolve(import.meta.dir, '../../..')
const engineRoot = path.join(repositoryRoot, 'third_party', 'codex-engine')
const productPatchRoot = path.join(repositoryRoot, 'third_party', 'codex-engine-patches')

type CliOptions = {
  applyProductPatches: boolean
}

function parseCliOptions(argv: string[]): CliOptions {
  let applyProductPatches = false
  for (const argument of argv) {
    if (argument === '--apply-product-patches') {
      applyProductPatches = true
      continue
    }
    throw new Error(`未知 Codex Engine 源码校验参数: ${argument}`)
  }
  return { applyProductPatches }
}

function requireFile(relativePath: string): string {
  const file = path.join(engineRoot, relativePath)
  if (!existsSync(file)) throw new Error(`Codex Engine 源码缺少 ${relativePath}；请执行 git submodule update --init --recursive`)
  return readFileSync(file, 'utf8')
}

function requireProductPatch(file: string): string {
  const patch = path.join(productPatchRoot, file)
  if (!existsSync(patch)) throw new Error(`Codex Engine 产品补丁缺少 ${file}`)
  return readFileSync(patch, 'utf8')
}

function productPatchSha256(file: string): string {
  // Git's canonical text form uses LF. Windows may materialize a text patch
  // with CRLF in its working directory, which must not change the reviewed
  // patch identity or make the cross-platform build reject the same commit.
  const canonicalPatch = readFileSync(path.join(productPatchRoot, file), 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(canonicalPatch, 'utf8').digest('hex')
}

function assertContains(source: string, fragment: string, description: string): void {
  if (!source.includes(fragment)) throw new Error(`Codex Engine 源码缺少 ${description}`)
}

function assertExactPatchTargets(
  patch: string,
  expectedTargets: readonly string[],
  patchFile: string,
): void {
  const targets = Array.from(patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm), match => {
    const source = match[1]
    const destination = match[2]
    if (!source || source !== destination) {
      throw new Error(`Codex Engine 产品补丁目标不合法: ${patchFile}`)
    }
    return source
  })
  if (
    targets.length !== expectedTargets.length
    || targets.some((target, index) => target !== expectedTargets[index])
  ) {
    throw new Error(`Codex Engine 产品补丁目标不符合审核合同: ${patchFile}`)
  }
}

function assertHookEnvironmentPatch(patch: string, patchFile: string): void {
  assertExactPatchTargets(patch, [
    'codex-rs/hooks/src/engine/command_runner.rs',
  ], patchFile)
  assertContains(patch, '+    remove_inherited_secret_environment(&mut command);', `${patchFile} 的 Hook 密钥过滤`)
  assertContains(patch, '+    command.envs(&handler.env);', `${patchFile} 的显式 Hook 环境恢复`)
  assertContains(patch, '+            command.env_remove(name);', `${patchFile} 的继承密钥移除`)
  assertContains(patch, '+    uppercase_name.contains("KEY")', `${patchFile} 的默认密钥匹配规则`)
  assertContains(patch, '+        || uppercase_name.contains("SECRET")', `${patchFile} 的默认密钥匹配规则`)
  assertContains(patch, '+        || uppercase_name.contains("TOKEN")', `${patchFile} 的默认密钥匹配规则`)
}

function assertNonToolChildEnvironmentPatch(patch: string, patchFile: string): void {
  assertExactPatchTargets(patch, [
    'codex-rs/app-server/src/request_processors/feedback_doctor_report.rs',
    'codex-rs/core-plugins/src/lib.rs',
    'codex-rs/core-plugins/src/loader.rs',
    'codex-rs/core-plugins/src/marketplace_add/install.rs',
    'codex-rs/core-plugins/src/marketplace_upgrade/git.rs',
    'codex-rs/core-plugins/src/npm_source.rs',
    'codex-rs/core-plugins/src/startup_sync.rs',
    'codex-rs/core-plugins/src/subprocess_environment.rs',
    'codex-rs/core/src/shell_snapshot.rs',
    'codex-rs/exec-server/src/client_transport.rs',
    'codex-rs/protocol/src/shell_environment.rs',
  ], patchFile)
  assertContains(patch, '+pub fn is_default_excluded_environment_variable_name', `${patchFile} 的共享密钥匹配规则`)
  assertContains(patch, '+    uppercase_name.contains("KEY")', `${patchFile} 的默认密钥匹配规则`)
  assertContains(patch, '+        || uppercase_name.contains("SECRET")', `${patchFile} 的默认密钥匹配规则`)
  assertContains(patch, '+        || uppercase_name.contains("TOKEN")', `${patchFile} 的默认密钥匹配规则`)
  assertContains(patch, '+            command.env_remove(name);', `${patchFile} 的继承密钥移除`)
  assertContains(patch, '+    remove_inherited_secret_environment(&mut command);', `${patchFile} 的插件子进程密钥过滤`)
}

function assertLegacyNotifyEnvironmentPatch(patch: string, patchFile: string): void {
  assertExactPatchTargets(patch, [
    'codex-rs/hooks/src/legacy_notify.rs',
  ], patchFile)
  assertContains(
    patch,
    '+use codex_protocol::shell_environment::is_default_excluded_environment_variable_name;',
    `${patchFile} 的共享密钥匹配规则`,
  )
  assertContains(
    patch,
    '+                    if is_default_excluded_environment_variable_name(&name) {',
    `${patchFile} 的通知 Hook 密钥过滤`,
  )
  assertContains(patch, '+                        command.env_remove(name);', `${patchFile} 的继承密钥移除`)
}

function assertProductPatchContents(patchFile: string, patch: string): void {
  if (patchFile === '0001-sanitize-hook-environment.patch') {
    assertHookEnvironmentPatch(patch, patchFile)
    return
  }
  if (patchFile === '0002-sanitize-non-tool-child-environment.patch') {
    assertNonToolChildEnvironmentPatch(patch, patchFile)
    return
  }
  if (patchFile === '0003-sanitize-legacy-notify-environment.patch') {
    assertLegacyNotifyEnvironmentPatch(patch, patchFile)
    return
  }
  throw new Error(`Codex Engine 产品补丁没有语义审核器: ${patchFile}`)
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

async function assertProductPatches(): Promise<void> {
  if (!existsSync(productPatchRoot)) throw new Error('Codex Engine 产品补丁目录缺失')
  const expectedPatches = [...CODEX_ENGINE_PRODUCT_PATCHES]
    .sort((left, right) => left.file.localeCompare(right.file))
  const expectedFiles = expectedPatches.map(patch => patch.file)
  const actualFiles = readdirSync(productPatchRoot, { withFileTypes: true })
    .map(entry => entry.name)
    .sort()
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error(`Codex Engine 产品补丁清单不完整或包含未审核文件: ${actualFiles.join(', ') || '（空）'}`)
  }

  const sourceStatus = await gitOutput('status', '--short')
  if (sourceStatus) throw new Error('Codex Engine 源码目录存在未提交改动，无法验证产品补丁基线')

  for (const expectedPatch of expectedPatches) {
    const patch = requireProductPatch(expectedPatch.file)
    if (productPatchSha256(expectedPatch.file) !== expectedPatch.sha256) {
      throw new Error(`Codex Engine 产品补丁内容不符合发行合同: ${expectedPatch.file}`)
    }
    assertProductPatchContents(expectedPatch.file, patch)
    await gitOutput('apply', '--check', path.join(productPatchRoot, expectedPatch.file))
  }
  await gitOutput(
    'apply',
    '--check',
    ...expectedPatches.map(patch => path.join(productPatchRoot, patch.file)),
  )
}

/**
 * CI uses this only after `assertProductPatches` has checked the clean pinned
 * source. Keeping application driven by the same contract as staging prevents
 * an added product patch from being silently skipped by the compile job.
 */
async function applyProductPatches(): Promise<void> {
  for (const patch of CODEX_ENGINE_PRODUCT_PATCHES) {
    const patchPath = path.join(productPatchRoot, patch.file)
    await gitOutput('apply', '--check', patchPath)
    await gitOutput('apply', '--whitespace=nowarn', patchPath)
  }
  await gitOutput('diff', '--check')
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2))
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }
  await assertProductPatches()
  if (options.applyProductPatches) await applyProductPatches()

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
  const hookCommandRunner = requireFile('codex-rs/hooks/src/engine/command_runner.rs')
  const coreRoot = requireFile('codex-rs/core/src/lib.rs')
  const coreConfig = requireFile('codex-rs/core/src/config/mod.rs')
  const coreSession = requireFile('codex-rs/core/src/session/mod.rs')
  const coreTurn = requireFile('codex-rs/core/src/session/turn.rs')
  const modelInfo = requireFile('codex-rs/protocol/src/openai_models.rs')
  const toolRouter = requireFile('codex-rs/core/src/tools/router.rs')
  const arg0Dispatch = requireFile('codex-rs/arg0/src/lib.rs')
  const execServerClientTransport = requireFile('codex-rs/exec-server/src/client_transport.rs')
  const codexV8Packaging = requireFile('scripts/codex_package/v8.py')
  const codexRipgrepPackaging = requireFile('scripts/codex_package/ripgrep.py')
  const codexRipgrepManifest = requireFile('scripts/codex_package/rg')
  const productEngineStaging = readFileSync(
    path.join(repositoryRoot, 'ts', 'desktop', 'scripts', 'stage-codex-engine.ts'),
    'utf8',
  )

  assertContains(appServerMain, 'arg0_dispatch_or_else', 'App Server 的本地 sandbox helper 分派入口')
  assertContains(appServerRuntime, 'ExecServerRuntimePaths::from_optional_paths(', 'App Server 的本地 Exec Server 运行路径')
  assertContains(appServerRuntime, 'EnvironmentManager::from_codex_home(', 'App Server 的本地执行环境管理器')
  assertContains(appServerRuntime, 'MessageProcessor::new(MessageProcessorArgs', 'App Server 的 JSON-RPC 消息处理器')
  assertContains(hookCommandRunner, 'fn build_command(', 'Core Hook 命令启动点')
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
  assertContains(execServerClientTransport, 'command.envs(&stdio_command.env)', '可配置 Exec Server 的显式环境入口')
  assertContains(codexV8Packaging, 'V8_ARTIFACT_PROFILE = "ptrcomp_sandbox_release"', 'Codex 官方 Sandbox V8 产物类型')
  assertContains(codexV8Packaging, 'https://github.com/openai/codex/releases/download/rusty-v8-v{version}', 'Codex 官方 Sandbox V8 发布源')
  assertContains(codexV8Packaging, 'expected_checksums = load_checksums', 'Codex 官方 Sandbox V8 校验清单')
  assertContains(codexV8Packaging, 'ensure_valid_artifact(', 'Codex 官方 Sandbox V8 文件校验')
  assertContains(codexRipgrepPackaging, 'fetch_dotslash_executable(', 'Codex 官方 ripgrep DotSlash 下载器')
  assertContains(codexRipgrepPackaging, 'raise AssertionError("ripgrep is required for all package targets")', 'Codex 官方包的必需 ripgrep 约束')
  assertContains(codexRipgrepManifest, '"hash": "sha256"', 'Codex 官方 ripgrep SHA-256 清单')
  assertContains(productEngineStaging, 'from codex_package.v8 import resolve_codex_v8_cargo_env', '产品构建复用锁定源码的 V8 准备器')
  assertContains(productEngineStaging, 'from codex_package.ripgrep import resolve_rg_bin', '产品构建复用锁定源码的 ripgrep 准备器')
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
  console.log(`[codex-engine] Rust App Server/Core/Thread/Context/Tool/Sandbox/Exec composition, Apache-2.0 NOTICE, the Responses-only provider baseline, native 90% automatic-compaction default, the official sandbox-enabled V8 and required ripgrep packaging helpers, and the reviewed product patch contract verified${options.applyProductPatches ? ' and applied' : ''}; personal model credentials remain in Electron through BilliardBuddy Responses bridges.`)
}

await main()
