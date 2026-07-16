import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Tool, ToolContext } from './Tool'
import { getAutoMemDir, getAutoMemEntrypoint } from '../harness/memoryNames'

/**
 * 「存记忆」工具(对齐 cc AutoMem 的模型自主写记忆机制,白标)。
 *
 * cc 让模型把攒到的结构化事实写成 memdir 里带 frontmatter 的 .md + 一行 MEMORY.md 索引,
 * 未来会话再把索引读回注入(我们的读侧在 harness/claudemd.ts:getMemoryFiles 的 AutoMem 层)。
 * 这里把「写」做成一等公民工具:模型在对话里学到值得长期记的事就调它,写盘位置与读侧
 * 完全一致(getAutoMemDir(workspace.root)),保证读写对齐同一目录/格式。
 *
 * 本机可逆(写自己配置目录、可 forget 删),不对外/不花钱 → 不走审批(Delta A 直接放行)。
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
type MemoryKind = (typeof MEMORY_TYPES)[number]

/**
 * 记忆 provenance(C1):区分「主 agent 在活跃对话里当场存的」vs「后台无人值守抽取子代理事后补存的」。
 * 用户在场时存的,存错了用户能立刻纠正;后台抽取没有这层实时校验,可信度天然低一档。
 * `extractMemories.ts` 的抽取 fork 用 querySource=MEMORY_EXTRACT_QUERY_SOURCE 调 runAgentLoop,
 * 该值经 loop.ts 写进 ToolContext.querySource,此处据此判断来源,不需要额外传参。
 */
export const MEMORY_EXTRACT_QUERY_SOURCE = 'builtin:memory-extract'
export type MemoryProvenance = 'agent' | 'background_extract'

function resolveProvenance(ctx: ToolContext): MemoryProvenance {
  return ctx.querySource === MEMORY_EXTRACT_QUERY_SOURCE ? 'background_extract' : 'agent'
}

interface SaveMemoryInput {
  name?: unknown
  description?: unknown
  type?: unknown
  content?: unknown
  forget?: unknown
}

export const SAVE_MEMORY_TOOL_NAME = 'save_memory'

export const saveMemoryTool: Tool<SaveMemoryInput> = {
  name: SAVE_MEMORY_TOOL_NAME,
  description: [
    '把值得长期记住的事写进你的持久记忆库,未来会话会自动读回。用它记「对话里用户明确说过/纠正过」的事实与偏好,',
    '让下次不用再问一遍。每条记忆写成一个带标题的小文件 + 一行索引;同名会覆盖更新(先更新已有、别重复记)。',
    '',
    '什么时候记(type 四类,必填其一):',
    '- user:用户是谁、角色、目标、长期偏好(例:这是一家社区台球房的店主,最看重晚间黄金档获客)。',
    '- feedback:用户对你做事方式的纠正或肯定(例:文案别写太长、别用绝对化广告词)。含「为什么」以便日后判断边界。',
    '- project:门店/工作的具体事实与近况,代码或历史里查不到的(例:黄金档台费、会员规则、常办的活动、旺季)。相对日期换成绝对日期。',
    '- reference:外部资料在哪(例:价目表在某个共享文档、素材在某文件夹)。',
    '',
    '安全红线(必须遵守):只记用户在对话里明确说过或纠正过的内容;拿不准就不记,禁止凭空补全、推测或编造门店信息。',
    '不记密钥/密码/隐私;不记从当前文件、命令、git 就能查到的东西;不记只对本次对话有用的临时状态。',
    '',
    'forget=true 时按 name 删除对应记忆(用户说「忘掉/别记得 X」时用)。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '这条记忆的短标题,兼作文件名与索引标题(例:黄金档台费、店主偏好)。同名视为同一条、覆盖更新。',
      },
      description: {
        type: 'string',
        description: '一行摘要(索引里用来判断相关性,尽量具体)。省略则取正文首行。',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: '记忆类型:user / feedback / project / reference。门店事实多为 project。',
      },
      content: {
        type: 'string',
        description: '记忆正文。feedback/project 建议:先写结论,再补「为什么」和「何时适用」。',
      },
      forget: {
        type: 'boolean',
        description: '为 true 时删除 name 对应的记忆(忘掉),此时可不传 content/type。',
      },
    },
    required: ['name'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    const name = cleanString(input?.name)
    if (!name) return '存记忆失败:必须给出 name(记忆标题)。'

    const memoryDir = getAutoMemDir(ctx.workspace.root)
    const fileName = memoryFileName(name)
    const filePath = join(memoryDir, fileName)
    // 纵深防御:slug 已剥掉分隔符与 .. ,再确认落点没逃出 memdir。
    if (!isInside(memoryDir, filePath)) return '存记忆失败:name 不是合法的记忆标题。'

    if (input?.forget === true) {
      return await forgetMemory(memoryDir, fileName, filePath, name)
    }

    const content = cleanString(input?.content)
    if (!content) return '存记忆失败:保存时必须给出 content(记忆正文);只想删除请传 forget=true。'
    const type = normalizeType(input?.type)
    const description = cleanString(input?.description) ?? firstLine(content)
    const provenance = resolveProvenance(ctx)

    await mkdir(memoryDir, { recursive: true })
    const body = renderMemoryFile({ name, description, type, content, provenance })
    await atomicWrite(filePath, body)
    await upsertIndexLine(getAutoMemEntrypoint(ctx.workspace.root), fileName, name, description)

    return `已记住「${name}」(类型 ${type})。未来会话会自动读回这条记忆。`
  },
}

// ─────────────────────────────────────────────────────────────────────────────

async function forgetMemory(memoryDir: string, fileName: string, filePath: string, name: string): Promise<string> {
  let removedFile = false
  try {
    await unlink(filePath)
    removedFile = true
  } catch {
    // 文件不在也没关系,继续清索引。
  }
  const removedIndex = await removeIndexLine(join(memoryDir, 'MEMORY.md'), fileName)
  if (!removedFile && !removedIndex) return `没有找到名为「${name}」的记忆,无需删除。`
  return `已忘掉「${name}」。`
}

function renderMemoryFile(m: { name: string; description: string; type: MemoryKind; content: string; provenance: MemoryProvenance }): string {
  const fm = [
    '---',
    `name: ${yamlScalar(m.name)}`,
    `description: ${yamlScalar(m.description)}`,
    `type: ${m.type}`,
    `provenance: ${m.provenance}`,
    '---',
    '',
    m.content.trim(),
    '',
  ]
  return fm.join('\n')
}

/** 升级或新增一行索引:`- [标题](文件.md) — 摘要`,按文件名去重。 */
async function upsertIndexLine(entrypoint: string, fileName: string, title: string, description: string): Promise<void> {
  const existing = await readFileOr(entrypoint, '')
  const line = `- [${sanitizeInline(title)}](${fileName}) — ${sanitizeInline(description)}`
  const marker = `](${fileName})`
  const lines = existing.length ? existing.split('\n') : []
  const header = lines.length && lines[0]!.startsWith('# ') ? undefined : '# MEMORY'
  const kept = lines.filter(l => !l.includes(marker))
  const out: string[] = []
  if (header) out.push(header, '')
  for (const l of kept) out.push(l)
  // 去掉尾部多余空行后追加。
  while (out.length && out[out.length - 1]!.trim() === '') out.pop()
  out.push(line, '')
  await atomicWrite(entrypoint, out.join('\n').replace(/\n{3,}/g, '\n\n'))
}

/** 删除索引里指向该文件的行。返回是否删到。 */
async function removeIndexLine(entrypoint: string, fileName: string): Promise<boolean> {
  const existing = await readFileOr(entrypoint, '')
  if (!existing) return false
  const marker = `](${fileName})`
  const lines = existing.split('\n')
  const kept = lines.filter(l => !l.includes(marker))
  if (kept.length === lines.length) return false
  await atomicWrite(entrypoint, kept.join('\n').replace(/\n{3,}/g, '\n\n'))
  return true
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeType(value: unknown): MemoryKind {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (MEMORY_TYPES as readonly string[]).includes(raw) ? (raw as MemoryKind) : 'project'
}

function firstLine(content: string): string {
  const line = content.split('\n').map(l => l.trim()).find(Boolean) ?? content.trim()
  return line.length > 150 ? `${line.slice(0, 147)}...` : line
}

/** 把标题压成安全文件名:剥掉分隔符/保留字符与前后点,折叠空白,保留中文与数字,截断,兜底加时间戳。 */
function memoryFileName(name: string): string {
  let slug = name
    .replace(/[<>:"/\\|?* - -]/g, ' ') // 文件系统保留字符 + 控制字符 + 空白(- 置末尾避免字符范围坑)
    .replace(/\s+/g, '_')
    .replace(/^[.\s_]+|[.\s_]+$/g, '') // 去掉前后的点/空白/下划线(防 ".." 逃逸、防隐藏文件)
    .slice(0, 80)
    .replace(/[.\s_]+$/g, '') // 截断后可能又露出尾部点/下划线,再清一次
  if (!slug || /^\.+$/.test(slug)) slug = `memory-${Date.now()}`
  return `${slug}.md`
}

/** 单行文本:去掉换行,防止污染 frontmatter/索引结构。 */
function sanitizeInline(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim()
}

/** YAML 纯量:含特殊字符时加双引号并转义,避免 frontmatter 解析歧义。 */
function yamlScalar(value: string): string {
  const v = sanitizeInline(value)
  if (v === '' || /[:#?{}[\]&*!|>%@`"'\n-]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return v
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent)
  const c = resolve(child)
  const rel = c.slice(p.length)
  return c.startsWith(p) && (rel === '' || rel.startsWith('/') || rel.startsWith('\\'))
}

async function readFileOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return fallback
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/** 便于宿主/测试拿到当前会话的 memdir。 */
export function resolveMemoryDir(ctx: Pick<ToolContext, 'workspace'>): string {
  return getAutoMemDir(ctx.workspace.root)
}
