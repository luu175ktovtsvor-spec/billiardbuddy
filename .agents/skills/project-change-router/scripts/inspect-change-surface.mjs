#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const terms = process.argv.slice(2).filter(Boolean)
if (terms.length === 0) {
  console.error('Usage: node inspect-change-surface.mjs <term> [...terms]')
  process.exit(2)
}

const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
if (rootResult.status !== 0) {
  console.error('Run this script inside a git repository.')
  process.exit(2)
}
const root = rootResult.stdout.trim()
if (!root || !existsSync(root)) process.exit(2)

const baseArgs = [
  '-n', '--hidden', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**',
  '--glob', '!**/build/**', '--glob', '!**/.git/**',
]

function runSection(title, extraArgs) {
  console.log(`\n## ${title}`)
  const result = spawnSync('rg', [...baseArgs, ...extraArgs, root], { encoding: 'utf8' })
  if (result.status !== 0 && result.status !== 1) {
    console.error(result.stderr.trim())
    process.exit(result.status ?? 2)
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean)
  console.log(lines.length > 0 ? lines.slice(0, 240).join('\n') : '(no matches)')
  if (lines.length > 240) console.log(`... ${lines.length - 240} more matches omitted`)
}

const pattern = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
runSection('代码与配置命中', ['-i', '-e', pattern])
runSection('契约与传输命中', ['-i', '-e', `(${pattern}).*(api|route|event|message|schema|request|response|ipc|ws|sse)|(?:api|route|event|message|schema|request|response|ipc|ws|sse).*(${pattern})`])
runSection('测试命中', ['-i', '--glob', '**/*test*', '-e', pattern])
