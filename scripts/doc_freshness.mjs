#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC_DIRS = [path.join(ROOT, 'docs'), path.join(ROOT, '交接-给新会话')]
const ARCHIVE_DIR = path.join(ROOT, 'docs', '归档')
const STALE_DAYS = 45

const BANNER_RE = /📌\s*(?:文档)?状态/
const DATE_RE = /最后核对\s*(\d{4})-(\d{1,2})-(\d{1,2})/
const REMOVABLE = ['可删', '历史', '已落地', '已否决', '废弃', '弃用', '📦', '❌']

function walkMarkdown(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries = []
    try {
      entries = readdirSync(current).sort()
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry)
      try {
        const info = statSync(full)
        if (info.isDirectory()) stack.push(full)
        else if (info.isFile() && full.endsWith('.md')) out.push(full)
      } catch {
        // ignore unreadable paths
      }
    }
  }
  return out.sort()
}

function isArchived(file) {
  if (!existsSync(ARCHIVE_DIR)) return false
  const rel = path.relative(ARCHIVE_DIR, file)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function gitIgnored(files) {
  if (files.length === 0) return new Set()
  try {
    const stdout = execFileSync('git', ['-C', ROOT, '-c', 'core.quotePath=false', 'check-ignore', ...files], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(stdout.split(/\r?\n/).filter(Boolean))
  } catch {
    return new Set()
  }
}

function daysSince(y, m, d) {
  const today = new Date()
  const current = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const then = Date.UTC(y, m - 1, d)
  if (Number.isNaN(then)) return null
  const age = Math.floor((current - then) / 86_400_000)
  return Number.isFinite(age) ? age : null
}

function scan() {
  const removable = []
  const stale = []
  const files = DOC_DIRS.flatMap(walkMarkdown)
  const ignored = gitIgnored(files)

  for (const file of files) {
    if (isArchived(file)) continue
    if (ignored.has(file)) continue
    const rel = path.relative(ROOT, file)
    let head = []
    try {
      head = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 8)
    } catch {
      continue
    }
    const banner = head.find(line => BANNER_RE.test(line))
    if (!banner) continue
    if (REMOVABLE.some(keyword => banner.includes(keyword))) {
      removable.push(rel)
      continue
    }
    const match = DATE_RE.exec(banner)
    if (!match) continue
    const y = Number(match[1])
    const m = Number(match[2])
    const d = Number(match[3])
    const age = daysSince(y, m, d)
    if (age !== null && age > STALE_DAYS) {
      stale.push(`${rel}(核对于 ${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')},${age} 天前)`)
    }
  }

  return { removable, stale }
}

function main() {
  const { removable, stale } = scan()
  if (removable.length === 0 && stale.length === 0) return
  console.log('📚 文档维护提醒(本项目规约见 CLAUDE.md「文档维护规约」):')
  if (removable.length > 0) {
    console.log(`🧹 这 ${removable.length} 份标了【可删/历史/已否决】却还留在现行区——建议挪进 docs/归档/(git mv,只搬不删、历史可查;也可用 /整理归档 一键处理):`)
    for (const item of removable) console.log(`   · ${item}`)
  }
  if (stale.length > 0) {
    console.log(`🕰 这 ${stale.length} 份现行文档久未核对——顺手核对并把顶部「最后核对」日期更新到今天:`)
    for (const item of stale) console.log(`   · ${item}`)
  }
  console.log('拿不准哪些过时?跑 /文档体检 深扫(交叉验代码工作是否真落地)。')
}

main()
