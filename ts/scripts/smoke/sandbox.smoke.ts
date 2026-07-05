// mac 真起 OS 沙箱:工作区内写入应成功;工作区外(home)写入应被系统拒绝(写围栏生效)。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-')))
const ws = new Workspace(root)
const sb = new Sandbox({ workspace: ws, enabled: true })

if (!sb.isOsSandboxActive()) {
  console.error('✗ OS 沙箱未激活(本机应为 mac/linux 且依赖就绪)——检查 checkDependencies')
  process.exit(1)
}

const insidePath = join(root, 'inside.txt')
const outsidePath = join(homedir(), `w3-escape-${process.pid}.txt`)

// 1) 工作区内写入 → 应成功
const insideWrap = await sb.wrapCommand(`printf hi > ${insidePath}`)
await run(insideWrap!.argv, insideWrap!.env, root)
const insideOk = existsSync(insidePath)

// 2) 工作区外(home)写入 → 应被拒(文件不该出现)
const outsideWrap = await sb.wrapCommand(`printf hi > ${outsidePath}`)
await run(outsideWrap!.argv, outsideWrap!.env, root)
const outsideBlocked = !existsSync(outsidePath)
if (existsSync(outsidePath)) rmSync(outsidePath) // 万一没拦住,清掉别留脏文件

console.log(`工作区内写入成功: ${insideOk}`)
console.log(`工作区外写入被拒: ${outsideBlocked}`)
if (insideOk && outsideBlocked) {
  console.log('✓ W3 OS 沙箱写围栏 smoke 通过')
  process.exit(0)
}
console.error('✗ W3 沙箱 smoke 失败(写围栏未按预期)')
process.exit(1)
