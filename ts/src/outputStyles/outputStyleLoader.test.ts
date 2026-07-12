import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOutputStyles, resolveOutputStyleConfig } from './outputStyleLoader'

test('keep-coding-instructions frontmatter 解析 + resolveOutputStyleConfig(未命中→null,命中→prompt+门控位)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostyle-'))
  try {
    writeFileSync(join(dir, 'teacher.md'), '---\nname: teacher\ndescription: 老师\n---\n用启发式讲解')
    writeFileSync(join(dir, 'strict.md'), '---\nname: strict\ndescription: 严谨\nkeep-coding-instructions: true\n---\n严格模式')
    const lib = await loadOutputStyles([{ source: 'user', dir }])
    expect(resolveOutputStyleConfig(lib, undefined)).toBeNull()
    expect(resolveOutputStyleConfig(lib, 'nonexistent')).toBeNull()
    const teacher = resolveOutputStyleConfig(lib, 'teacher')
    expect(teacher?.prompt).toContain('用启发式讲解')
    expect(teacher?.keepCodingInstructions).toBeUndefined() // 未声明 → 跳过编码指令
    const strict = resolveOutputStyleConfig(lib, 'strict')
    expect(strict?.keepCodingInstructions).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
