#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Verifies that GitHub workflows only invoke package scripts that actually exist,
// so a green quality gate can never be followed by a runtime "command not found".
// The old checker string-matched required script names (ui:build/desktop:build/
// build:sidecar) that were never defined in any package.json — it passed while the
// Windows job would have died at runtime. This version resolves every `bun run
// <script>` against the package.json of its step's working-directory.

const root = path.resolve(import.meta.dir, '../..')
const errors: string[] = []

type Workflow = { text: string; data: Record<string, unknown> }

async function workflow(name: string): Promise<Workflow> {
  const text = await readFile(path.join(root, '.github/workflows', name), 'utf8')
  return { text, data: Bun.YAML.parse(text) as Record<string, unknown> }
}

async function packageScripts(relDir: string): Promise<Set<string> | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, relDir, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    return new Set(Object.keys(pkg.scripts ?? {}))
  } catch {
    return null
  }
}

// Map a step's working-directory to the repo-relative dir whose package.json owns
// its `bun run` scripts. '' / '.' means repo root (which has no package.json here).
function scriptDirFor(workingDirectory: string): string {
  return workingDirectory.replace(/\/+$/, '').replace(/^\.\/?/, '')
}

type Step = { run: string; workingDirectory: string }

function collectSteps(wf: Workflow): Step[] {
  const steps: Step[] = []
  const jobs = (wf.data.jobs ?? {}) as Record<string, { steps?: Array<Record<string, unknown>> }>
  for (const job of Object.values(jobs)) {
    for (const step of job.steps ?? []) {
      const run = step.run
      if (typeof run !== 'string') continue
      const wd = typeof step['working-directory'] === 'string' ? (step['working-directory'] as string) : ''
      steps.push({ run, workingDirectory: wd })
    }
  }
  return steps
}

async function verifyReferencedScripts(name: string, wf: Workflow): Promise<void> {
  const cache = new Map<string, Set<string> | null>()
  for (const step of collectSteps(wf)) {
    const scriptRefs = [...step.run.matchAll(/\bbun run ([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g)].map(m => m[1]!)
    if (scriptRefs.length === 0) continue
    const dir = scriptDirFor(step.workingDirectory)
    if (!cache.has(dir)) cache.set(dir, await packageScripts(dir))
    const scripts = cache.get(dir)!
    for (const ref of scriptRefs) {
      if (scripts === null) {
        errors.push(`${name}: 步骤 working-directory "${step.workingDirectory || '.'}" 无 package.json，却调用 bun run ${ref}`)
      } else if (!scripts.has(ref)) {
        errors.push(`${name}: 引用了不存在的 package script "${ref}"（working-directory ${step.workingDirectory || '.'} / ${dir || '仓库根'}/package.json）`)
      }
    }
  }
}

const quality = await workflow('ts-harness-ci.yml')
const qualityOn = quality.data.on as { push?: { branches?: string[] }; pull_request?: unknown } | undefined
if (!qualityOn?.push?.branches?.includes('main')) errors.push('ts-harness-ci.yml: push 必须监听 main')
if (!qualityOn || !('pull_request' in qualityOn)) errors.push('ts-harness-ci.yml: 必须监听 pull_request')
if (!quality.text.includes('bash scripts/quality_gate.sh')) errors.push('ts-harness-ci.yml: 必须执行统一质量门')
if (/e2e:desktop|desktop-e2e|playwright/i.test(quality.text)) errors.push('ts-harness-ci.yml: 不应重新引入已移除的桌面脚本测试')
await verifyReferencedScripts('ts-harness-ci.yml', quality)

const windows = await workflow('desktop-build-win.yml')
// Retired flat working-directories (web/server/desktop): the real trees are ts/ and ts/desktop/.
for (const retired of ['working-directory: web', 'working-directory: server', 'working-directory: desktop\n']) {
  if (windows.text.includes(retired)) errors.push(`desktop-build-win.yml: 仍引用退役目录 ${retired.split(': ')[1]!.trim()}`)
}
if (!windows.text.includes('bash scripts/quality_gate.sh')) errors.push('desktop-build-win.yml: 打包前必须先过质量门')
// Packaging must go through a real --publish-never entrypoint; never auto-publish to a user channel.
if (!/bun run electron:package(:dir)?\b/.test(windows.text) && !/bun run build:windows-x64\b/.test(windows.text)) {
  errors.push('desktop-build-win.yml: 必须用真实打包入口 electron:package（内置 --publish never）或 build:windows-x64')
}
if (/--publish\s+(always|onTag|onTagOrDraft)/.test(windows.text)) errors.push('desktop-build-win.yml: 不得自动发布（--publish 只能是 never）')
if (/\bscp\b|DEPLOY_SSH|desktop-updates/.test(windows.text)) errors.push('desktop-build-win.yml: 当前更新渠道未完成，不得自动上传用户更新目录')
await verifyReferencedScripts('desktop-build-win.yml', windows)

if (errors.length > 0) {
  console.error(`GitHub 工作流检查失败（${errors.length} 项）:\n${errors.join('\n')}`)
  process.exit(1)
}
console.log('GitHub 工作流检查通过：引用的 package script 均真实存在')
