import { describe, expect, test } from 'bun:test'
import { buildGeneralRegistry } from '../tools/generalTools'
import { filePathsFromInput, filePathToolOperation } from './filePathRuleMatch'
import type { JSONSchema } from '../tools/Tool'

// ── 防再漂移的核心测试 ────────────────────────────────────────────────────────────
// 根因:文件工具集合 + filePathsFromInput 是「硬编码工具名」,必须手工跟 registry 同步;Tool 接口
// 无 getPath,漏挂编译发现不了。本文件遍历「真实 registry」的每个工具,逼将来新增文件工具当场归类:
//   • 会读/写「入参路径指向的那个文件的内容」→ 必须被 gate(进 READ/WRITE_PATH_TOOLS + filePathsFromInput);
//   • 目录列举/跨文件搜索/不 emit 入参文件内容 → 显式登记进 NOT_INPUT_GATED(走输出层 ignore 过滤)。
// 二者都不满足就让「漂移哨兵」测试红。

// 应被 input-gate 的每个文件工具 → 代表性入参 + 期望抽出的路径(证明分类与抽路径都正确)。
const GATED: Record<string, { op: 'read' | 'write'; input: unknown; expect: string[] }> = {
  read_file: { op: 'read', input: { path: 'a.txt' }, expect: ['a.txt'] },
  read_many_files: { op: 'read', input: { paths: ['a.txt', 'b.txt'] }, expect: ['a.txt', 'b.txt'] },
  code_outline: { op: 'read', input: { path: 'a.ts' }, expect: ['a.ts'] },
  file_history: { op: 'read', input: { path: 'a.txt' }, expect: ['a.txt'] },
  write_file: { op: 'write', input: { path: 'a.txt' }, expect: ['a.txt'] },
  edit_file: { op: 'write', input: { path: 'a.txt' }, expect: ['a.txt'] },
  multi_edit_file: { op: 'write', input: { path: 'a.txt' }, expect: ['a.txt'] },
  patch_file: { op: 'write', input: { path: 'a.txt' }, expect: ['a.txt'] },
  patch_files: { op: 'write', input: { patches: [{ path: 'a.txt' }, { path: 'b.txt' }] }, expect: ['a.txt', 'b.txt'] },
  edit_excel: { op: 'write', input: { path: 'a.xlsx' }, expect: ['a.xlsx'] },
  NotebookEdit: { op: 'write', input: { notebook_path: 'a.ipynb' }, expect: ['a.ipynb'] },
  restore_file: { op: 'write', input: { path: 'a.txt' }, expect: ['a.txt'] },
}

// 入参含文件路径字段、但有意「不」经 matchingRuleForInput 入参 gate 的工具(理由见 filePathRuleMatch.ts 头注)。
const NOT_INPUT_GATED = new Set([
  'list_dir',
  'glob_files',
  'grep_files',
  'git_status',
  'git_history',
  'project_diagnostics',
  'list_project_instructions',
  'LSP',
  // path 被校验只能落在本会话工具结果存储目录内,不是工作区文件路径。
  'read_stored_tool_result',
])

// inputSchema 顶层出现这些键之一 = 长得像「带文件路径入参」的工具。
const PATH_SHAPE_KEYS = ['path', 'paths', 'notebook_path', 'filePath', 'patches', 'ranges', 'test_paths']

function schemaKeys(schema: JSONSchema): string[] {
  const props = (schema.properties ?? {}) as Record<string, unknown>
  return Object.keys(props)
}

describe('文件路径工具 gate 覆盖(防漂移哨兵)', () => {
  const registry = buildGeneralRegistry()

  test('每个应被 gate 的文件工具:已注册、分类正确、能抽出入参路径', () => {
    for (const [name, spec] of Object.entries(GATED)) {
      const t = registry.get(name)
      expect(t, `registry 缺少工具 ${name}(GATED 与 registry 漂移)`).toBeDefined()
      expect(filePathToolOperation(t!), `${name} 未被识别为 ${spec.op} 文件工具`).toBe(spec.op)
      expect(
        filePathsFromInput(t!, spec.input).slice().sort(),
        `${name} 的 filePathsFromInput 抽不到期望路径`,
      ).toEqual([...spec.expect].sort())
    }
  })

  test('漂移哨兵:任何带文件路径入参的已注册工具,要么被 gate,要么被显式登记为不 gate', () => {
    const offenders: string[] = []
    for (const t of registry.list()) {
      const looksLikeFileTool = schemaKeys(t.inputSchema).some(k => PATH_SHAPE_KEYS.includes(k))
      if (!looksLikeFileTool) continue
      const gated = filePathToolOperation(t) !== null
      if (!gated && !NOT_INPUT_GATED.has(t.name)) offenders.push(t.name)
    }
    expect(
      offenders,
      `这些已注册工具的入参含文件路径字段,却既没被 gate、也没登记在 NOT_INPUT_GATED:` +
        `${offenders.join(', ')}。请判断它是否会读/写「入参路径指向的那个文件的内容」:` +
        `是→加进 READ_PATH_TOOLS/WRITE_PATH_TOOLS + filePathsFromInput + 本测试 GATED;` +
        `否(目录列举/跨文件搜索,走输出层 ignore 过滤)→加进本测试 NOT_INPUT_GATED。`,
    ).toEqual([])
  })

  test('登记为不 gate 的路径类工具确实没被 input-gate(边界锁定,防误挂)', () => {
    for (const name of NOT_INPUT_GATED) {
      const t = registry.get(name)
      if (!t) continue
      expect(filePathToolOperation(t), `${name} 不应被 input-gate(如确要 gate 请同步更新本测试)`).toBeNull()
    }
  })

  test('GATED 与 NOT_INPUT_GATED 不重叠', () => {
    for (const name of Object.keys(GATED)) {
      expect(NOT_INPUT_GATED.has(name), `${name} 同时出现在 GATED 与 NOT_INPUT_GATED`).toBe(false)
    }
  })
})
