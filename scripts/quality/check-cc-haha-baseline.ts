#!/usr/bin/env bun
import path from 'node:path'
import { evaluateChangePolicy } from '../../ts/scripts/pr/change-policy.ts'

// Read-only CC-Haha baseline-drift audit.
//
// ts/ was imported wholesale from cc-haha (upstream d318b1b) at commit a46c1a7c.
// This audit diffs the current ts/ tree against that import commit using Git as the
// sole source of truth (no hand-copied file manifest) and reports how far the local
// tree has drifted: unchanged / modified / added / deleted.
//
// Policy:
//   - BilliardBuddy product adaptations (modified + added) are EXPECTED, not failures.
//     The default run only reports them.
//   - A DELETED upstream path is a hard block: the invariant is that no cc-haha file
//     is removed by product work. If deletions appear, the audit fails and demands an
//     explanation / an intentional upstream-upgrade task.
//   - Modifications under cc-haha's protected core dirs are surfaced (reusing the
//     kernel's own change-policy classification), not re-gated here — the authoritative
//     gate for those is `bun run check:policy` + the allow-cli-core-change label.

const root = path.resolve(import.meta.dir, '../..')
const IMPORT_COMMIT = 'a46c1a7c' // chore(core): import cc-haha baseline at d318b1b
const SUBTREE = 'ts'

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

// 1) Confirm the import baseline commit is reachable in this repo's history.
if (git(['cat-file', '-t', IMPORT_COMMIT]).stdout.trim() !== 'commit') {
  console.error(`CC-Haha 基线审计失败：找不到导入基线提交 ${IMPORT_COMMIT}（ts/ 全量导入点）。`)
  process.exit(1)
}

// 2) Upstream file set = the ts/ tree at the import commit (Git tree is the source of truth).
const upstreamList = git(['ls-tree', '-r', '--name-only', IMPORT_COMMIT, '--', SUBTREE])
if (upstreamList.code !== 0) {
  console.error(`CC-Haha 基线审计失败：无法读取导入提交的 ts/ 树:\n${upstreamList.stderr}`)
  process.exit(1)
}
const upstreamFiles = new Set(upstreamList.stdout.split('\n').filter(Boolean))

// 3) Drift = import commit vs current working tree, restricted to ts/. No rename detection,
//    so a moved upstream file shows as delete(old)+add(new) and the missing old path is flagged.
const diff = git(['diff', '--name-status', '--no-renames', IMPORT_COMMIT, '--', SUBTREE])
if (diff.code !== 0) {
  console.error(`CC-Haha 基线审计失败：git diff 失败:\n${diff.stderr}`)
  process.exit(1)
}

const modified: string[] = []
const added: string[] = []
const deleted: string[] = []
for (const line of diff.stdout.split('\n').filter(Boolean)) {
  const [status, ...rest] = line.split('\t')
  const file = rest.join('\t')
  if (!file) continue
  const code = status![0]
  if (code === 'M') modified.push(file)
  else if (code === 'A') added.push(file)
  else if (code === 'D') deleted.push(file)
  else if (code === 'T') modified.push(file) // type change counts as a modification
}

const unchanged = upstreamFiles.size - modified.length - deleted.length

// 4) Reuse cc-haha's own change-policy to flag which adaptations touch protected core dirs.
//    change-policy paths are relative to ts/, so strip the leading "ts/".
const driftForPolicy = [...modified, ...added].map(f => f.replace(/^ts\//, ''))
const policy = evaluateChangePolicy(driftForPolicy)
const cliCoreTouched = policy.cliCoreFiles

console.log('CC-Haha 基线偏差审计（基准: 导入提交 %s / 上游 d318b1b，事实源 = Git tree）', IMPORT_COMMIT)
console.log(`  上游文件总数 : ${upstreamFiles.size}`)
console.log(`  unchanged    : ${unchanged}`)
console.log(`  modified     : ${modified.length}`)
console.log(`  added        : ${added.length}`)
console.log(`  deleted      : ${deleted.length}`)
if (cliCoreTouched.length > 0) {
  console.log(`  其中改动到 cc-haha 受保护核心目录（cli-core）的文件 ${cliCoreTouched.length} 个（授权走 check:policy + allow-cli-core-change，非本审计门禁）:`)
  for (const f of cliCoreTouched) console.log(`    · ts/${f}`)
}

const verbose = process.argv.includes('--list')
if (verbose) {
  if (modified.length) console.log(`\n[modified]\n${modified.map(f => `  M ${f}`).join('\n')}`)
  if (added.length) console.log(`\n[added]\n${added.map(f => `  A ${f}`).join('\n')}`)
}

// 5) The only hard failure: an upstream cc-haha path disappeared.
if (deleted.length > 0) {
  console.error(`\nCC-Haha 基线审计失败：检测到 ${deleted.length} 个上游原始路径被删除（本任务要求 deleted 恒为 0）:`)
  for (const f of deleted) console.error(`  D ${f}`)
  console.error('删除 cc-haha 内核文件必须单独立项说明；若为上游升级，请另开独立升级任务，不在质量门内静默删除。')
  process.exit(1)
}

console.log('\nCC-Haha 基线审计通过：无上游路径删除（deleted=0）；modified/added 为预期内产品接轨，仅报告。')
