#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')
const canonicalRoot = path.join(root, '.agents/skills')
const claudeRoot = path.join(root, '.claude/skills')
const errors: string[] = []

function frontmatter(text: string, file: string): { data: Record<string, unknown>; body: string } | null {
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
  return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

const canonical = new Map<string, string>()
for (const folder of await directories(canonicalRoot)) {
  const skillFile = path.join(canonicalRoot, folder, 'SKILL.md')
  try {
    await stat(skillFile)
  } catch {
    errors.push(`.agents/skills/${folder}: 缺少 SKILL.md`)
    continue
  }
  const parsed = frontmatter(await readFile(skillFile, 'utf8'), `.agents/skills/${folder}/SKILL.md`)
  if (!parsed) continue
  const name = parsed.data.name
  const description = parsed.data.description
  if (name !== folder) errors.push(`.agents/skills/${folder}: frontmatter name 必须与目录名一致`)
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) errors.push(`.agents/skills/${folder}: name 必须是小写英文、数字或连字符`)
  if (typeof description !== 'string' || description.length < 80 || description.includes('TODO')) errors.push(`.agents/skills/${folder}: description 必须明确说明能力和触发场景`)
  if (Object.keys(parsed.data).some(key => !['name', 'description'].includes(key))) errors.push(`.agents/skills/${folder}: SKILL.md frontmatter 只能包含 name 和 description`)
  if (parsed.body.split(/\r?\n/).length > 500) errors.push(`.agents/skills/${folder}: SKILL.md 超过 500 行，应拆 references`)
  if (typeof name === 'string') canonical.set(name, folder)

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

const wrapperTargets = new Set<string>()
const wrapperNames = new Set<string>()
for (const folder of await directories(claudeRoot)) {
  const skillFile = path.join(claudeRoot, folder, 'SKILL.md')
  try {
    await stat(skillFile)
  } catch {
    continue
  }
  const text = await readFile(skillFile, 'utf8')
  const parsed = frontmatter(text, `.claude/skills/${folder}/SKILL.md`)
  if (!parsed) continue
  const name = parsed.data.name
  if (typeof name !== 'string' || name.length === 0) errors.push(`.claude/skills/${folder}: name 不能为空`)
  else if (wrapperNames.has(name)) errors.push(`.claude/skills/${folder}: Claude Skill 名称重复: ${name}`)
  else wrapperNames.add(name)
  for (const match of text.matchAll(/\.agents\/skills\/([a-z0-9-]+)\/SKILL\.md/g)) wrapperTargets.add(match[1]!)
}

for (const name of canonical.keys()) {
  if (!wrapperTargets.has(name)) errors.push(`.agents/skills/${name}: 缺少指向该权威 Skill 的 Claude 中文入口`)
}
for (const target of wrapperTargets) {
  if (!canonical.has(target)) errors.push(`Claude 中文入口指向不存在的权威 Skill: ${target}`)
}

if (errors.length > 0) {
  console.error(`工程 Skill 校验失败（${errors.length} 项）:\n${errors.join('\n')}`)
  process.exit(1)
}
console.log(`工程 Skill 校验通过：${canonical.size} 个权威 Skill，${wrapperTargets.size} 个 Claude 对应入口`)
