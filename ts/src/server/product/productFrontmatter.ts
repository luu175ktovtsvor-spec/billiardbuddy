import { parseDocument } from 'yaml'

export type ProductFrontmatter = {
  paths?: string | string[] | null
}

export function parseProductFrontmatter(markdown: string): { frontmatter: ProductFrontmatter; content: string } {
  const normalized = markdown.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: {}, content: markdown }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { frontmatter: {}, content: markdown }
  const document = parseDocument(normalized.slice(4, end), {
    prettyErrors: false,
    strict: true,
  })
  if (document.errors.length) return { frontmatter: {}, content: markdown }
  const value = document.toJS({ maxAliasCount: 0 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { frontmatter: {}, content: markdown }
  const paths = (value as Record<string, unknown>).paths
  const validPaths = typeof paths === 'string'
    ? paths
    : Array.isArray(paths) && paths.every(item => typeof item === 'string')
      ? paths as string[]
      : undefined
  return {
    frontmatter: validPaths === undefined ? {} : { paths: validPaths },
    content: normalized.slice(end + 5),
  }
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
  if (!match) return [pattern]
  const [, prefix = '', alternatives = '', suffix = ''] = match
  return alternatives.split(',').flatMap(part => expandBraces(`${prefix}${part.trim()}${suffix}`))
}

export function splitProductPaths(input: string | string[]): string[] {
  if (Array.isArray(input)) return input.flatMap(splitProductPaths)
  const result: string[] = []
  let current = ''
  let depth = 0
  for (const character of input) {
    if (character === '{') depth += 1
    else if (character === '}') depth = Math.max(0, depth - 1)
    if (character === ',' && depth === 0) {
      if (current.trim()) result.push(current.trim())
      current = ''
    } else current += character
  }
  if (current.trim()) result.push(current.trim())
  return result.flatMap(expandBraces)
}
