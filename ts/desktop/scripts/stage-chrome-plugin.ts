import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveCargoCommand, type WindowsNativeTarget, verifyProductContent, verifyProductSkill, verifyStdioMcpHandshake, verifyWindowsPeMachine } from './native-build-tools'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

type StageOptions = { destinationDir: string, target: SupportedTarget, verifyOnly?: boolean }
type CliOptions = { destinationDir?: string, target?: string, verifyOnly: boolean }

const PLUGIN = 'billiardbuddy-chrome'
const EXTENSION_ID = 'hkglcfbkjjaljnieaecddhihnleoocbb'
const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const sourceRoot = join(repositoryRoot, 'native', PLUGIN)
const pluginSourceRoot = join(desktopRoot, 'runtime-assets', 'plugins', PLUGIN)

function parseCli(argv: string[]): CliOptions {
  let destinationDir: string | undefined
  let target: string | undefined
  let verifyOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--verify') { verifyOnly = true; continue }
    if (argument === '--destination' || argument === '--target') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      if (argument === '--destination') destinationDir = value
      else target = value
      index += 1
      continue
    }
    throw new Error(`未知 Chrome 插件参数: ${argument}`)
  }
  return { destinationDir, target, verifyOnly }
}

function detectTarget(platform = process.platform, arch = process.arch): SupportedTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 BilliardBuddy Chrome 插件平台: ${platform}/${arch}`)
}

function validTarget(value: string): value is SupportedTarget {
  return ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(value)
}

function binary(name: string, target: SupportedTarget): string { return target.includes('windows') ? `${name}.exe` : name }
function requireFile(file: string): void {
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Chrome 插件缺少正式文件: ${file}`)
}
function cargo(): string {
  return resolveCargoCommand('缺少 Rust Cargo；请在 macOS/Windows 原生构建机或 GitHub Actions 上构建 BilliardBuddy Chrome 插件')
}
function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 20 * 60_000 })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter((value): value is string => Boolean(value?.trim())).join('\n')
    throw new Error(`Chrome 插件命令失败: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
}
function extensionId(publicKey: string): string {
  const hash = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)
  return [...hash].map(value => String.fromCharCode(97 + Number.parseInt(value, 16))).join('')
}

export function verifyStagedChromePlugin(options: StageOptions): void {
  const root = join(resolve(options.destinationDir), PLUGIN)
  for (const file of [
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, '.mcp.json'),
    join(root, 'skills', 'chrome-control', 'SKILL.md'),
    join(root, 'chrome-extension', 'manifest.json'),
    join(root, 'chrome-extension', 'background.js'),
    join(root, 'bin', binary(PLUGIN, options.target)),
    join(root, 'bin', binary(`${PLUGIN}-native-host`, options.target)),
  ]) requireFile(file)
  const plugin = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')) as { name?: string, mcpServers?: string, skills?: string }
  if (plugin.name !== PLUGIN || plugin.mcpServers !== './.mcp.json' || plugin.skills !== './skills/') throw new Error('Chrome 插件 manifest 不符合本地插件合同')
  verifyProductContent(join(root, '.codex-plugin', 'plugin.json'))
  verifyProductSkill(join(root, 'skills', 'chrome-control', 'SKILL.md'))
  const skill = readFileSync(join(root, 'skills', 'chrome-control', 'SKILL.md'), 'utf8')
  if (!skill.includes('cdp_send') || !skill.includes('cdp_read_events') || !skill.includes('wait_for_page')) throw new Error('Chrome 技能缺少受控开发者模式说明')
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, { command?: string, cwd?: string, env_vars?: unknown }> }
  const server = mcp.mcpServers?.[PLUGIN]
  if (server?.command !== `./bin/${PLUGIN}` || server.cwd !== '.' || !Array.isArray(server.env_vars) || !server.env_vars.includes('CODEX_HOME')) throw new Error('Chrome 插件 MCP 配置无效')
  const extension = JSON.parse(readFileSync(join(root, 'chrome-extension', 'manifest.json'), 'utf8')) as { manifest_version?: number, key?: string, permissions?: unknown }
  if (
    extension.manifest_version !== 3
    || !extension.key
    || extensionId(extension.key) !== EXTENSION_ID
    || !Array.isArray(extension.permissions)
    || extension.permissions.length !== 3
    || !['activeTab', 'debugger', 'nativeMessaging'].every(permission => extension.permissions?.includes(permission))
  ) throw new Error('Chrome 扩展身份或最小权限配置无效')
  const background = readFileSync(join(root, 'chrome-extension', 'background.js'), 'utf8')
  // Parse the service worker without executing Chrome globals.
  new Function(background)
  if (!background.includes("nativePort.postMessage({ kind: 'hello' })")) throw new Error('Chrome 扩展缺少 Native Messaging 握手')
  if (background.includes('el.value ||')) throw new Error('Chrome 页面检查不得读取表单当前值')
  if (!background.includes("['type', 'name', 'id', 'aria-label', 'placeholder', 'title']") || !background.includes('bbSensitiveAutocomplete')) throw new Error('Chrome 扩展缺少完整凭据字段保护')
  if (
    !background.includes('const bbFileUpload')
    || !background.includes('.filter(el => !bbFileUpload(el))')
    || !background.includes("if (bbFileUpload(entry.node)) return { ok: false, reason: 'file' };")
    || !background.includes("if (bbFileUpload(node)) return { ok: false, reason: 'file' };")
  ) throw new Error('Chrome 扩展不得暴露或操作文件上传控件')
  if (!background.includes("await evaluate(Number(tabId), '({ url: location.href, title: document.title })')")) throw new Error('Chrome 扩展必须在每次操作前重新确认当前网址')
  if (background.includes('data-billiardbuddy-element') || !background.includes("'Page.createIsolatedWorld'") || !background.includes('bbAncestry') || !background.includes('bbFingerprint(entry.node) === entry.fingerprint')) {
    throw new Error('Chrome 扩展元素 ID 必须保存在隔离 world，并在操作前校验节点快照')
  }
  if (!background.includes("method !== 'Page.frameNavigated'")) throw new Error('Chrome 扩展缺少顶层导航撤权处理')
  if (!background.includes('await applyPolicy(message.policy)')) throw new Error('Chrome 扩展缺少动态网站策略更新')
  if (!background.includes('navigation?.errorText')) throw new Error('Chrome 扩展未校验导航失败结果')
  if (!background.includes('image.data.length > MAX_SCREENSHOT_DATA')) throw new Error('Chrome 扩展缺少截图回传上限')
  if (!background.includes("['DOM.getDocument', 'Page.getLayoutMetrics', 'Performance.getMetrics']") || !background.includes("op === 'cdp_read_events'") || !background.includes("op === 'wait_for_page'")) {
    throw new Error('Chrome 扩展未锁定受控开发者模式命令白名单')
  }
  if (background.includes('Network.getResponseBody') || background.includes('Storage.getCookies')) throw new Error('Chrome 扩展不得开放凭据面或响应体读取')
  const nativeHost = readFileSync(join(sourceRoot, 'src', 'native_host.rs'), 'utf8')
  if (!nativeHost.includes('let policy = Policy::load(&runtime_root);') || !nativeHost.includes('policy.command_fields()')) {
    throw new Error('Chrome Native Host 必须在每次工具调用前重读网站策略')
  }
  if (!nativeHost.includes('| "cdp_send"') || !nativeHost.includes('| "cdp_read_events"') || !nativeHost.includes('| "wait_for_page"')) {
    throw new Error('Chrome Native Host 未转发受控开发者模式命令')
  }
  const mcpSource = readFileSync(join(sourceRoot, 'src', 'mcp.rs'), 'utf8')
  if (!mcpSource.includes('"DOM.getDocument" | "Page.getLayoutMetrics" | "Performance.getMetrics"') || !mcpSource.includes('"cdp_read_events"') || !mcpSource.includes('"wait_for_page"')) {
    throw new Error('Chrome MCP 未锁定受控开发者模式命令白名单')
  }
  const market = JSON.parse(readFileSync(join(resolve(options.destinationDir), '..', '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins?: Array<{ name?: string, source?: { path?: string } }> }
  if (!market.plugins?.some(entry => entry.name === PLUGIN && entry.source?.path === `./plugins/${PLUGIN}`)) throw new Error('BilliardBuddy 本地市场缺少 Chrome 插件')
  for (const name of [PLUGIN, `${PLUGIN}-native-host`]) {
    const file = join(root, 'bin', binary(name, options.target))
    if (lstatSync(file).size < 100_000) throw new Error(`Chrome 插件二进制大小无效: ${file}`)
    if (options.target.includes('windows')) verifyWindowsPeMachine(file, options.target as WindowsNativeTarget)
  }
  verifyStdioMcpHandshake(join(root, 'bin', binary(PLUGIN, options.target)), options.target, PLUGIN)
}

export function stageChromePlugin(options: StageOptions): void {
  if (options.verifyOnly) return verifyStagedChromePlugin(options)
  for (const file of [
    join(sourceRoot, 'Cargo.toml'), join(sourceRoot, 'src', 'mcp.rs'), join(sourceRoot, 'src', 'native_host.rs'),
    join(pluginSourceRoot, '.codex-plugin', 'plugin.json'), join(pluginSourceRoot, '.mcp.json'),
    join(pluginSourceRoot, 'skills', 'chrome-control', 'SKILL.md'), join(pluginSourceRoot, 'chrome-extension', 'manifest.json'), join(pluginSourceRoot, 'chrome-extension', 'background.js'),
  ]) requireFile(file)
  const destination = resolve(options.destinationDir)
  const marketplaceRoot = join(destination, '..')
  mkdirSync(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
  copyFileSync(join(desktopRoot, 'runtime-assets', 'marketplace.json'), join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'))
  const root = join(destination, PLUGIN)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(pluginSourceRoot, root, { recursive: true, dereference: false, filter: source => !source.endsWith('/bin') && !source.endsWith('\\bin') })
  const destinationBin = join(root, 'bin')
  mkdirSync(destinationBin, { recursive: true })
  const executable = cargo()
  for (const name of [PLUGIN, `${PLUGIN}-native-host`]) {
    run(executable, ['build', '--locked', '--release', '--target', options.target, '--bin', name, '--manifest-path', join(sourceRoot, 'Cargo.toml')], sourceRoot)
    const source = join(sourceRoot, 'target', options.target, 'release', binary(name, options.target))
    requireFile(source)
    const output = join(destinationBin, binary(name, options.target))
    copyFileSync(source, output)
    if (!options.target.includes('windows')) chmodSync(output, 0o755)
  }
  verifyStagedChromePlugin(options)
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2))
  const target = cli.target ?? process.env.BILLIARDBUDDY_CHROME_PLUGIN_TARGET ?? detectTarget()
  if (!validTarget(target)) throw new Error(`不支持的 Chrome 插件 target: ${target}`)
  stageChromePlugin({ destinationDir: cli.destinationDir ?? join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins'), target, verifyOnly: cli.verifyOnly })
  console.log(`[chrome-plugin] ${cli.verifyOnly ? 'verified' : 'staged'} for ${target}`)
}
