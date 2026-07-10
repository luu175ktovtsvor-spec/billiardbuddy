// mac 真起 OS 沙箱:工作区内写入应成功;工作区外(home)写入应被系统拒绝(写围栏生效)。
// 另验三个 §04 审计修复(真机、非 mock):P0 fullDiskAccess 联动 + P1 additionalWorkingDirectories
// 接入 allowWrite + P1 denyWrite 保护 .billiardbuddy 敏感配置。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../../src/sandbox/sandbox'
import { Workspace } from '../../src/workspace/workspace'

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return new Promise(res => {
    const c = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env } })
    c.on('close', code => res(code ?? -1))
    c.on('error', () => res(-1))
  })
}

async function runPlainOrWrapped(sb: Sandbox, command: string, cwd: string, extraWritablePaths?: string[]): Promise<void> {
  const wrapped = await sb.wrapCommand(command, { extraWritablePaths })
  if (wrapped) {
    await run(wrapped.argv, wrapped.env, cwd)
  } else {
    await run(['sh', '-c', command], {}, cwd)
  }
}

const results: Array<{ label: string; ok: boolean }> = []
function record(label: string, ok: boolean): void {
  results.push({ label, ok })
  console.log(`${ok ? '✓' : '✗'} ${label}`)
}

// ── 场景 1(原有):工作区写围栏基线 ─────────────────────────────────────────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-')))
  const ws = new Workspace(root)
  const sb = new Sandbox({ workspace: ws, enabled: true })

  if (!sb.isOsSandboxActive()) {
    console.error('✗ OS 沙箱未激活(本机应为 mac/linux 且依赖就绪)——检查 checkDependencies')
    process.exit(1)
  }

  const insidePath = join(root, 'inside.txt')
  const outsidePath = join(homedir(), `w3-escape-${process.pid}.txt`)

  const insideWrap = await sb.wrapCommand(`printf hi > ${insidePath}`)
  await run(insideWrap!.argv, insideWrap!.env, root)
  record('工作区内写入成功', existsSync(insidePath))

  const outsideWrap = await sb.wrapCommand(`printf hi > ${outsidePath}`)
  await run(outsideWrap!.argv, outsideWrap!.env, root)
  record('工作区外写入被拒', !existsSync(outsidePath))
  if (existsSync(outsidePath)) rmSync(outsidePath) // 万一没拦住,清掉别留脏文件
}

// ── 场景 2(P0 #10):fullDiskAccess 会话 → 沙箱视为不激活,工作区外写入不再被拦 ──────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-fda-')))
  const ws = new Workspace(root, { fullDiskAccess: true })
  const sb = new Sandbox({ workspace: ws, enabled: true })

  record('fullDiskAccess 会话:isOsSandboxActive() 为 false', !sb.isOsSandboxActive())

  const outsidePath = join(homedir(), `w3-fda-${process.pid}.txt`)
  await runPlainOrWrapped(sb, `printf hi > ${outsidePath}`, root)
  record('fullDiskAccess 会话:run_command 写工作区外(home)不再被沙箱拦(P0 修复生效)', existsSync(outsidePath))
  if (existsSync(outsidePath)) rmSync(outsidePath)
}

// ── 场景 3(P1 #7):additionalWorkingDirectories → 并入 OS 沙箱 allowWrite ───────────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-extra-')))
  const ws = new Workspace(root)
  const sb = new Sandbox({ workspace: ws, enabled: true })

  const authorizedDir = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-authorized-')))
  const unauthorizedDir = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-unauthorized-')))
  const authorizedPath = join(authorizedDir, 'from-agent-memory.txt')
  const unauthorizedPath = join(unauthorizedDir, 'should-stay-blocked.txt')

  await runPlainOrWrapped(sb, `printf hi > ${authorizedPath}`, root, [authorizedDir])
  record('additionalWorkingDirectories 授权目录:写入放行', existsSync(authorizedPath))

  await runPlainOrWrapped(sb, `printf hi > ${unauthorizedPath}`, root, [authorizedDir])
  record('未授权的另一工作区外目录:写入仍被拒(extraWritablePaths 不是全放行)', !existsSync(unauthorizedPath))

  rmSync(authorizedDir, { recursive: true, force: true })
  rmSync(unauthorizedDir, { recursive: true, force: true })
  if (existsSync(unauthorizedPath)) rmSync(unauthorizedPath)
}

// ── 场景 4(P1 #8):denyWrite 保护工作区内 .billiardbuddy 敏感配置 ──────────────────
{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-deny-')))
  const ws = new Workspace(root)
  const sb = new Sandbox({ workspace: ws, enabled: true })

  mkdirSync(join(root, '.billiardbuddy'), { recursive: true })
  const settingsPath = join(root, '.billiardbuddy', 'settings.json')
  const normalPath = join(root, 'normal.txt')

  await runPlainOrWrapped(sb, `printf '{"permissions":{"allow":["Bash(*)"]}}' > ${settingsPath}`, root)
  record('denyWrite:.billiardbuddy/settings.json 在工作区内仍被拒写', !existsSync(settingsPath))
  if (existsSync(settingsPath)) rmSync(settingsPath)

  await runPlainOrWrapped(sb, `printf hi > ${normalPath}`, root)
  record('denyWrite 不误伤:工作区内普通文件仍可写', existsSync(normalPath))
}

// ── 场景 5(R4 返工 CONFIRMED #1):跨工作区 Sandbox 单例互相覆写,EPERM 误杀 ────────────
{
  const rootA = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-race-a-')))
  const rootB = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-race-b-')))
  const sbA = new Sandbox({ workspace: new Workspace(rootA), enabled: true })
  const sbB = new Sandbox({ workspace: new Workspace(rootB), enabled: true })

  const a1 = join(rootA, 'a1.txt')
  await runPlainOrWrapped(sbA, `printf hi > ${a1}`, rootA)
  record('跨工作区互不覆写:A 先写自己 root 成功', existsSync(a1))

  const b1 = join(rootB, 'b1.txt')
  await runPlainOrWrapped(sbB, `printf hi > ${b1}`, rootB)
  record('跨工作区互不覆写:B 首次初始化(触发 SandboxManager.updateConfig)后写自己 root 成功', existsSync(b1))

  const a2 = join(rootA, 'a2.txt')
  await runPlainOrWrapped(sbA, `printf hi > ${a2}`, rootA)
  record('跨工作区互不覆写:A 在 B 初始化之后再写自己 root 仍成功(此前会被 B 覆写的全局 allowWrite 误杀 EPERM)', existsSync(a2))
}

// ── 场景 6(R4 返工 CONFIRMED #2):workspace root 落在 symlink 前缀下,denyWrite 细粒度规则仍生效 ──
{
  // 故意不 realpath:mkdtempSync 在 mac 上落 /var/folders/...(symlink → /private/var/...),
  // 复刻生产 workspaceFromBody() 从不对 client 传来的 working_dir 做 realpath 的路径形态
  // (场景 1~4 的 root 全经 realpathSync 包一层,测不出这条——这正是 R4 报告点名的假绿信号来源)。
  const root = mkdtempSync(join(tmpdir(), 'w3-smoke-symlink-'))
  const realRoot = realpathSync(root)
  record('前置断言:mkdtempSync 未 realpath 的 root 确实经过 symlink(否则这条场景测不出问题)', root !== realRoot)

  const ws = new Workspace(root)
  const sb = new Sandbox({ workspace: ws, enabled: true })

  mkdirSync(join(root, '.billiardbuddy'), { recursive: true })
  const settingsPath = join(root, '.billiardbuddy', 'settings.json')
  const normalPath = join(root, 'normal.txt')

  await runPlainOrWrapped(sb, `printf '{"permissions":{"allow":["Bash(*)"]}}' > ${settingsPath}`, root)
  record('symlink root 下 denyWrite 仍生效:settings.json 被拒写', !existsSync(settingsPath))
  if (existsSync(settingsPath)) rmSync(settingsPath)

  await runPlainOrWrapped(sb, `printf hi > ${normalPath}`, root)
  record('symlink root 下 denyWrite 不误伤:普通文件仍可写', existsSync(normalPath))
}

console.log('')
const failed = results.filter(r => !r.ok)
if (failed.length === 0) {
  console.log('✓ W3/§04 OS 沙箱 smoke 全部通过')
  process.exit(0)
}
console.error(`✗ ${failed.length} 项失败:${failed.map(r => r.label).join('; ')}`)
process.exit(1)
