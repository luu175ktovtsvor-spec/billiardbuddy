import { resolve, sep } from 'node:path'

export function commonpath(paths: string[]): string {
  if (paths.length === 0) return ''
  const resolved = paths.map(path => resolve(path).split(sep).filter(Boolean))
  const first = resolved[0] ?? []
  const out: string[] = []
  for (let i = 0; i < first.length; i++) {
    const part = first[i]
    if (resolved.every(path => path[i] === part)) out.push(part)
    else break
  }
  const prefix = paths[0]?.startsWith(sep) ? sep : ''
  return prefix + out.join(sep)
}
