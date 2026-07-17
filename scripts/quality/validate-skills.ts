#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const rootFlag = process.argv.indexOf('--root')
const root = rootFlag >= 0 && process.argv[rootFlag + 1]
  ? path.resolve(process.argv[rootFlag + 1]!)
  : path.resolve(import.meta.dir, '../..')
const canonicalRoot = path.join(root, '.agents/skills')
const claudeRoot = path.join(root, '.claude/skills')
const errors: string[] = []

interface ParsedSkill {
  data: Record<string, unknown>
  body: string
}

interface CanonicalSkill extends ParsedSkill {
  folder: string
  file: string
}

function frontmatter(text: string, file: string): ParsedSkill | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!match) {
    errors.push(`${file}: 缺少合法 YAML frontmatter`)
    return null
  }
  try {
    return { data: Bun.YAML.parse(match[1]!) as Record<string, unknown>, body: match[2]! }
  } catch (error) {
    errors.push(`${file}: YAML 无法解析: ${String(error)}`)
    return null
  }
}

async function directories(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    errors.push(`${path.relative(root, dir)}: 无法读取目录: ${String(error)}`)
    return []
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function requiredText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    errors.push(`${path.relative(root, file)}: 缺失或无法读取: ${String(error)}`)
    return ''
  }
}

const canonical = new Map<string, CanonicalSkill>()
for (const folder of await directories(canonicalRoot)) {
  const skillFile = path.join(canonicalRoot, folder, 'SKILL.md')
  const displayFile = `.agents/skills/${folder}/SKILL.md`
  if (!await exists(skillFile)) {
    errors.push(`.agents/skills/${folder}: 缺少 SKILL.md`)
    continue
  }
  const parsed = frontmatter(await readFile(skillFile, 'utf8'), displayFile)
  if (!parsed) continue
  const name = parsed.data.name
  const description = parsed.data.description
  if (name !== folder) errors.push(`.agents/skills/${folder}: frontmatter name 必须与目录名一致`)
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) errors.push(`.agents/skills/${folder}: name 必须是小写英文、数字或连字符`)
  if (typeof description !== 'string' || description.length < 80 || description.includes('TODO')) errors.push(`.agents/skills/${folder}: description 必须明确说明能力和触发场景`)
  if (Object.keys(parsed.data).some(key => !['name', 'description'].includes(key))) errors.push(`.agents/skills/${folder}: SKILL.md frontmatter 只能包含 name 和 description`)
  if (parsed.body.split(/\r?\n/).length > 500) errors.push(`.agents/skills/${folder}: SKILL.md 超过 500 行，应拆 references`)
  if (parsed.body.includes('[TODO')) errors.push(`.agents/skills/${folder}: SKILL.md 仍包含模板 TODO`)
  if (typeof name === 'string') canonical.set(name, { ...parsed, folder, file: skillFile })

  const metadataFile = path.join(canonicalRoot, folder, 'agents/openai.yaml')
  try {
    const metadata = Bun.YAML.parse(await readFile(metadataFile, 'utf8')) as { interface?: Record<string, unknown> }
    const displayName = metadata.interface?.display_name
    const short = metadata.interface?.short_description
    const prompt = metadata.interface?.default_prompt
    if (typeof displayName !== 'string' || !/[\u3400-\u9fff]/.test(displayName)) errors.push(`.agents/skills/${folder}: display_name 应使用中文`)
    if (typeof short !== 'string' || short.length < 25 || short.length > 64) errors.push(`.agents/skills/${folder}: short_description 长度应为 25-64 字符`)
    if (typeof prompt !== 'string' || !prompt.includes(`$${folder}`)) errors.push(`.agents/skills/${folder}: default_prompt 必须显式包含 $${folder}`)
  } catch (error) {
    errors.push(`.agents/skills/${folder}: agents/openai.yaml 缺失或无法解析: ${String(error)}`)
  }
}

const wrapperNames = new Set<string>()
const wrappersByTarget = new Map<string, string[]>()
for (const folder of await directories(claudeRoot)) {
  const skillFile = path.join(claudeRoot, folder, 'SKILL.md')
  if (!await exists(skillFile)) {
    errors.push(`.claude/skills/${folder}: 缺少 SKILL.md`)
    continue
  }
  const text = await readFile(skillFile, 'utf8')
  const parsed = frontmatter(text, `.claude/skills/${folder}/SKILL.md`)
  if (!parsed) continue
  const name = parsed.data.name
  const description = parsed.data.description
  if (typeof name !== 'string' || name.length === 0) errors.push(`.claude/skills/${folder}: name 不能为空`)
  else if (wrapperNames.has(name)) errors.push(`.claude/skills/${folder}: Claude Skill 名称重复: ${name}`)
  else wrapperNames.add(name)
  if (typeof description !== 'string' || description.length < 25) errors.push(`.claude/skills/${folder}: description 必须明确说明触发场景`)

  const targets = [...text.matchAll(/\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md/g)].map(match => match[1]!)
  if (targets.length !== 1) {
    errors.push(`.claude/skills/${folder}: 必须且只能指向一个权威 Skill，当前为 ${targets.length} 个`)
    continue
  }
  const target = targets[0]!
  wrappersByTarget.set(target, [...(wrappersByTarget.get(target) ?? []), folder])
}

for (const name of canonical.keys()) {
  const wrappers = wrappersByTarget.get(name) ?? []
  if (wrappers.length === 0) errors.push(`.agents/skills/${name}: 缺少指向该权威 Skill 的 Claude 中文入口`)
  if (wrappers.length > 1) errors.push(`.agents/skills/${name}: 存在多个 Claude 中文入口: ${wrappers.join(', ')}`)
}
for (const target of wrappersByTarget.keys()) {
  if (!canonical.has(target)) errors.push(`Claude 中文入口指向不存在的权威 Skill: ${target}`)
}

const router = canonical.get('project-change-router')
if (!router) {
  errors.push('.agents/skills/project-change-router: 缺少总路由 Skill')
} else {
  const routed = new Set([...router.body.matchAll(/\.\.\/([a-z0-9-]+)\/SKILL\.md/g)].map(match => match[1]!))
  for (const name of canonical.keys()) {
    if (name !== 'project-change-router' && !routed.has(name)) errors.push(`project-change-router: 未路由权威 Skill ${name}`)
  }
  for (const name of routed) {
    if (!canonical.has(name)) errors.push(`project-change-router: 指向不存在的 Skill ${name}`)
  }
}

const agentsText = await requiredText(path.join(root, 'AGENTS.md'))
for (const required of [
  '.agents/skills/project-change-router/SKILL.md',
  '.agents/skills/verify-modular-change/SKILL.md',
  '.agents/skills/maintain-project-skills/SKILL.md',
  'bash scripts/quality_gate.sh',
]) {
  if (!agentsText.includes(required)) errors.push(`AGENTS.md: 缺少工程治理入口 ${required}`)
}

const qualityGate = await requiredText(path.join(root, 'scripts/quality_gate.sh'))
if (!qualityGate.includes('scripts/quality/validate-skills.ts')) errors.push('scripts/quality_gate.sh: 未执行工程 Skill 校验')

let packageScripts = new Set<string>()
try {
  const packageJson = JSON.parse(await readFile(path.join(root, 'ts/package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  packageScripts = new Set(Object.keys(packageJson.scripts ?? {}))
} catch (error) {
  errors.push(`ts/package.json: 无法读取 scripts: ${String(error)}`)
}
for (const skill of canonical.values()) {
  for (const match of skill.body.matchAll(/bun run ([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g)) {
    const command = match[1]!
    if (!packageScripts.has(command)) errors.push(`.agents/skills/${skill.folder}: 引用了不存在的 ts package script: ${command}`)
  }
}

const projectPathPrefixes = [
  '.agents/',
  '.claude/',
  '.github/',
  'docs/',
  'gateway/',
  'relay/',
  'scripts/',
  'ts/desktop/',
  'ts/e2e/',
  'ts/shared/',
  'ts/src/',
]
for (const skill of canonical.values()) {
  for (const match of skill.body.matchAll(/`([^`\n]+)`/g)) {
    const reference = match[1]!.replace(/\/$/, '')
    if (!projectPathPrefixes.some(prefix => reference.startsWith(prefix))) continue
    if (reference.startsWith('ts/test-results/') || /[\s*<>{}|]/.test(reference)) continue
    if (!await exists(path.join(root, reference))) errors.push(`.agents/skills/${skill.folder}: 引用了不存在的项目路径 ${reference}`)
  }
}

const moduleMap = await requiredText(path.join(canonicalRoot, 'project-change-router/references/project-module-map.md'))

// Retired structures must not reappear in engineering skills or the module map.
// (renderer-react tree, ts/shared contracts dir, and ts/src/assets are gone from the cc-haha base.)
const retiredMarkers = ['renderer-react', 'ts/shared/', 'ts/src/assets']
const deadScanTargets: Array<[string, string]> = [
  ...[...canonical.values()].map(skill => [`.agents/skills/${skill.folder}/SKILL.md`, skill.body] as [string, string]),
  ['project-module-map.md', moduleMap],
]
for (const [label, text] of deadScanTargets) {
  for (const marker of retiredMarkers) {
    if (text.includes(marker)) errors.push(`${label}: 引用了已退役结构 ${marker}（当前 cc-haha 底座已无此路径）`)
  }
}

// Every concrete project path the module map names must resolve on disk
// (globs, placeholders and bare identifiers are skipped). Keeps the map honest with the tree.
const mapPathPrefixes = ['ts/', 'gateway/', 'relay/', 'scripts/', '.github/', '.agents/', '.claude/', 'docs/']
for (const match of moduleMap.matchAll(/`([^`\n]+)`/g)) {
  const reference = match[1]!.replace(/\/$/, '')
  if (!mapPathPrefixes.some(prefix => reference.startsWith(prefix))) continue
  if (/[\s*<>{}|]/.test(reference)) continue
  if (!await exists(path.join(root, reference))) errors.push(`project-module-map.md: 引用了不存在的路径 ${reference}`)
}

if (errors.length > 0) {
  console.error(`工程 Skill 校验失败（${errors.length} 项）:\n${errors.join('\n')}`)
  process.exit(1)
}
console.log(`工程 Skill 校验通过：${canonical.size} 个权威 Skill，${wrappersByTarget.size} 个 Claude 单一入口，语义引用有效`)
