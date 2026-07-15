import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOutputStyles, resolveOutputStyleConfig } from './outputStyleLoader'

test('resolveOutputStyleConfig(未命中→null,命中→prompt)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostyle-'))
  try {
    writeFileSync(join(dir, 'teacher.md'), '---\nname: teacher\ndescription: 老师\n---\n用启发式讲解')
    const lib = await loadOutputStyles([{ source: 'user', dir }])
    expect(resolveOutputStyleConfig(lib, undefined)).toBeNull()
    expect(resolveOutputStyleConfig(lib, 'nonexistent')).toBeNull()
    const teacher = resolveOutputStyleConfig(lib, 'teacher')
    expect(teacher?.prompt).toContain('用启发式讲解')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
