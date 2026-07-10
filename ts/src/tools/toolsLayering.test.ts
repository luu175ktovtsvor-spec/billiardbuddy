import { test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))

function collectTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      out.push(...collectTsFiles(abs))
    } else if (entry.endsWith('.ts')) {
      out.push(abs)
    }
  }
  return out
}

// 分层护栏:内核工具层(tools/)是低层,绝不允许反向 import server/ 层。
// 这是本次把 officeDocuments 下沉到 utils/ 后要锁死的方向——依赖只能 tools/ -> utils/,
// 不能 tools/ -> server/。任何工具文件(含测试)出现指向上一级 server 目录的 import 都视为倒挂回归。
test('tools/ 层不反向依赖 server/ 层', () => {
  const offenders: string[] = []
  for (const file of collectTsFiles(TOOLS_DIR)) {
    const src = readFileSync(file, 'utf8')
    if (/from\s+['"]\.\.\/server(\/|['"])/.test(src)) {
      offenders.push(file)
    }
  }
  expect(offenders).toEqual([])
})
