import { textBlock, type Message } from '../types/message'

export interface InvokedSkillInfo {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  scopeId: string | null
}

const MAX_SKILL_CONTENT_CHARS = 16_000
const MAX_SKILLS_TOTAL_CHARS = 48_000
const invokedSkills = new Map<string, InvokedSkillInfo>()

function keyFor(scopeId: string | null | undefined, skillName: string): string {
  return `${scopeId ?? ''}:${skillName}`
}

function normalizeScope(scopeId: string | null | undefined): string | null {
  return scopeId ?? null
}

export function addInvokedSkill(skillName: string, skillPath: string, content: string, scopeId?: string | null): void {
  const name = skillName.trim()
  if (!name || !content.trim()) return
  const normalizedScope = normalizeScope(scopeId)
  invokedSkills.set(keyFor(normalizedScope, name), {
    skillName: name,
    skillPath: skillPath.trim() || name,
    content,
    invokedAt: Date.now(),
    scopeId: normalizedScope,
  })
}

export function getInvokedSkillsForScope(scopeId?: string | null): InvokedSkillInfo[] {
  const normalizedScope = normalizeScope(scopeId)
  return [...invokedSkills.values()]
    .filter(skill => skill.scopeId === normalizedScope)
    .sort((a, b) => b.invokedAt - a.invokedAt)
}

export function clearInvokedSkills(scopeId?: string | null): void {
  if (scopeId === undefined) {
    invokedSkills.clear()
    return
  }
  const normalizedScope = normalizeScope(scopeId)
  for (const [key, skill] of invokedSkills) {
    if (skill.scopeId === normalizedScope) invokedSkills.delete(key)
  }
}

export function createInvokedSkillsMessage(scopeId?: string | null): Message | null {
  const skills: Array<{ name: string; path: string; content: string }> = []
  let used = 0
  for (const skill of getInvokedSkillsForScope(scopeId)) {
    const content = truncate(skill.content, MAX_SKILL_CONTENT_CHARS)
    if (used + content.length > MAX_SKILLS_TOTAL_CHARS) continue
    used += content.length
    skills.push({ name: skill.skillName, path: skill.skillPath, content })
  }
  if (skills.length === 0) return null
  return {
    role: 'user',
    content: [textBlock(formatInvokedSkills(skills))],
  }
}

export function restoreInvokedSkillsFromMessages(messages: Message[], scopeId?: string | null): number {
  let restored = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'text') continue
      for (const skill of parseInvokedSkills(block.text)) {
        addInvokedSkill(skill.name, skill.path, skill.content, scopeId)
        restored++
      }
    }
  }
  return restored
}

function formatInvokedSkills(skills: Array<{ name: string; path: string; content: string }>): string {
  return [
    '[压缩后恢复的已调用技能]',
    '下面是本会话已经执行过、压缩后仍需保留的技能说明:',
    '<invoked_skills>',
    ...skills.map(skill => [
      `<invoked_skill name="${xmlAttr(skill.name)}" path="${xmlAttr(skill.path)}">`,
      skill.content,
      '</invoked_skill>',
    ].join('\n')),
    '</invoked_skills>',
  ].join('\n')
}

function parseInvokedSkills(text: string): Array<{ name: string; path: string; content: string }> {
  const out: Array<{ name: string; path: string; content: string }> = []
  const re = /<invoked_skill\s+name="([^"]*)"\s+path="([^"]*)">\n?([\s\S]*?)\n?<\/invoked_skill>/g
  for (const match of text.matchAll(re)) {
    const name = xmlUnattr(match[1] ?? '').trim()
    const path = xmlUnattr(match[2] ?? '').trim()
    const content = (match[3] ?? '').trim()
    if (name && content) out.push({ name, path: path || name, content })
  }
  return out
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n[已截断:技能内容超过 ${maxChars} 字符]`
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmlUnattr(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
