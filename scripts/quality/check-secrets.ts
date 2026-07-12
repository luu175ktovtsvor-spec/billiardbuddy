#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')
const tracked = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
if (tracked.exitCode !== 0) throw new Error(tracked.stderr.toString())

const files = tracked.stdout.toString().split('\0').filter(Boolean)
const errors: string[] = []
const secretPatterns: Array<[string, RegExp]> = [
  ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI 风格密钥', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['GitHub Token', /\bgh[opsu]_[A-Za-z0-9]{30,}\b/],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/],
]

for (const file of files) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !/\.example$|\.sample$/.test(file)) {
    errors.push(`${file}: 不得跟踪真实 .env 文件`)
  }
  const absolute = path.join(root, file)
  let content: Buffer
  try {
    content = await readFile(absolute)
  } catch {
    continue
  }
  if (content.includes(0) || content.length > 5_000_000) continue
  const text = content.toString('utf8')
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) errors.push(`${file}: 命中高置信度${label}格式`)
  }
}

if (errors.length > 0) {
  console.error(`密钥检查失败（${errors.length} 项）:\n${errors.join('\n')}`)
  process.exit(1)
}
console.log(`密钥检查通过：扫描 ${files.length} 个已跟踪文件`)
