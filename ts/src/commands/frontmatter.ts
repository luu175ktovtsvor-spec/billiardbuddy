export interface MarkdownDocument {
  frontmatter: Record<string, unknown>
  body: string
}

function coerceScalar(raw: string): unknown {
  const value = raw.trim()
  if (!value) return ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1)
      .split(',')
      .map(x => String(coerceScalar(x)))
      .map(x => x.trim())
      .filter(Boolean)
  }
  return value
}

export function parseMarkdownDocument(text: string): MarkdownDocument {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { frontmatter: {}, body: normalized }
  }
  const lines = normalized.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end === -1) return { frontmatter: {}, body: normalized }

  const frontmatter: Record<string, unknown> = {}
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    frontmatter[m[1]!] = coerceScalar(m[2] ?? '')
  }
  return { frontmatter, body: lines.slice(end + 1).join('\n').trimStart() }
}

export function stringField(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const v = frontmatter[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

export function stringArrayField(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
  const v = frontmatter[key]
  if (Array.isArray(v)) return v.map(String).map(x => x.trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return v.split(',').map(x => x.trim()).filter(Boolean)
  return undefined
}

export function extractDescription(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue
    return trimmed.replace(/^[-*]\s+/, '').slice(0, 240)
  }
  return ''
}
