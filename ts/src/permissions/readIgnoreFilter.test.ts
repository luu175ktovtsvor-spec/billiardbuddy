// 输出层 read-ignore 过滤的行为对齐测试(验收硬闸)。
//
// 断言依据:cc 的输出层 ignore(GlobTool/GrepTool 用 getFileReadIgnorePatterns → Read-deny 规则 →
// ripgrep --glob !pattern)与我们输入层拒读判定共用同一个 gitignore 引擎(fileGlobMatchesPathForRule =
// cc matchingRuleForInput 的移植 + vendored ignore@7.0.5)。因此这里用「刁钻边界」把两件事一起钉死:
//   (A) pathHiddenByReadDeny 的路径判定,与 resolve.test.ts 里 read_file 拒读判定逐点一致(同引擎);
//   (B) list_dir / glob_files / grep_files 的真实输出确实把被忽略的路径剔掉。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { Tool, ToolContext } from '../tools/Tool'
import type { PermissionRule } from './types'
import { DEFAULT_IGNORED_VCS_SEGMENTS, pathHiddenByReadDeny } from './readIgnoreFilter'
import { resolvePermission } from './resolve'
import { listDirTool } from '../tools/listDirTool'
import { globFilesTool, grepFilesTool } from '../tools/searchTools'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'read-ignore-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function denyRule(ruleContent?: string, toolName = 'Read'): PermissionRule {
  return {
    source: 'projectSettings',
    ruleBehavior: 'deny',
    ruleValue: ruleContent === undefined ? { toolName } : { toolName, ruleContent },
  }
}
function ctxWith(rules: PermissionRule[]): ToolContext {
  return { workspace: new Workspace(root), permissionRules: rules }
}

// 最小 read_file 工具,用来和输入层拒读判定对照(read_file ∈ READ_PATH_TOOLS)。
const readTool: Tool = {
  name: 'read_file',
  description: '',
  inputSchema: { type: 'object' },
  isReadOnly: true,
  async execute() {
    return ''
  },
}
/** 输入层:read_file 读该相对路径是否被拒(bypassPermissions 下只剩规则起作用)。 */
function readDenied(ctx: ToolContext, relPath: string): boolean {
  return (
    resolvePermission(readTool, { path: relPath }, { ...ctx, permissionMode: 'bypassPermissions' }).behavior ===
    'deny'
  )
}
/** 输出层:该相对路径(解析成绝对路径后)是否被 read-deny 剔除。 */
function hidden(ctx: ToolContext, relPath: string): boolean {
  return pathHiddenByReadDeny(ctx, join(root, relPath))
}

describe('pathHiddenByReadDeny —— 输出层与输入层同引擎(刁钻边界)', () => {
  test('无规则:什么都不剔除', () => {
    const ctx = ctxWith([])
    expect(hidden(ctx, '.env')).toBe(false)
    expect(hidden(ctx, 'src/index.ts')).toBe(false)
  })

  test('deny Read(.env):基名任意深度命中,foo.env 不误伤 —— 与输入层逐点一致', () => {
    const ctx = ctxWith([denyRule('.env')])
    for (const p of ['.env', 'sub/deep/.env', 'sub/../.env']) {
      expect(hidden(ctx, p)).toBe(true)
      expect(readDenied(ctx, p)).toBe(true) // 不变量:输出剔除 ⟺ 读被拒
    }
    expect(hidden(ctx, 'foo.env')).toBe(false)
    expect(readDenied(ctx, 'foo.env')).toBe(false)
  })

  test('deny Read(**/secrets/**):任意层级 secrets 子目录命中,无关路径放行', () => {
    const ctx = ctxWith([denyRule('**/secrets/**')])
    for (const p of ['config/secrets/key.pem', 'a/b/secrets/c/d.txt', 'secrets/token']) {
      expect(hidden(ctx, p)).toBe(true)
      expect(readDenied(ctx, p)).toBe(true)
    }
    expect(hidden(ctx, 'src/index.ts')).toBe(false)
  })

  test('deny Read(/.env):根锚定只命中工作区根级,不命中子目录', () => {
    const ctx = ctxWith([denyRule('/.env')])
    expect(hidden(ctx, '.env')).toBe(true)
    expect(hidden(ctx, 'sub/.env')).toBe(false)
    expect(readDenied(ctx, '.env')).toBe(true)
    expect(readDenied(ctx, 'sub/.env')).toBe(false)
  })

  test('穿越到工作区外的路径:工作区作用域规则不匹配(../escape 不误命中)', () => {
    const ctx = ctxWith([denyRule('.env')])
    // 绝对路径归一后落在 root 之外 → 相对路径以 ../ 开头 → 跳过。
    expect(pathHiddenByReadDeny(ctx, join(root, '..', 'outside.env'))).toBe(false)
    // 对照:工作区内同名被剔除。
    expect(hidden(ctx, '.env')).toBe(true)
  })

  test('通配工具名 * + 路径 glob(*.pem)对读输出生效', () => {
    const ctx = ctxWith([denyRule('*.pem', '*')])
    expect(hidden(ctx, 'certs/server.pem')).toBe(true)
    expect(readDenied(ctx, 'certs/server.pem')).toBe(true)
    expect(hidden(ctx, 'certs/server.crt')).toBe(false)
  })

  test('Edit-deny 不外溢到读输出(只有 Read-deny 才剔除)', () => {
    const ctx = ctxWith([denyRule('.env', 'Edit')])
    expect(hidden(ctx, '.env')).toBe(false)
    expect(readDenied(ctx, '.env')).toBe(false) // 输入层同样:Edit deny 不禁读
  })

  test('裸 deny Read(无 ruleContent):不产出 ignore 模式,输出层不剔除(对齐 cc)', () => {
    const ctx = ctxWith([denyRule(undefined)])
    // cc getFileReadIgnorePatterns 只收带 content 的规则;裸规则 → 无 glob → 输出层不隐藏。
    expect(hidden(ctx, 'anything.txt')).toBe(false)
    // (输入层这里会拒读——这是刻意与输入层不一致的唯一点,与 cc 一致。)
    expect(readDenied(ctx, 'anything.txt')).toBe(true)
  })

  test('DEFAULT_IGNORED_VCS_SEGMENTS 含 cc 的 VCS 全集(至少含 .git)', () => {
    expect([...DEFAULT_IGNORED_VCS_SEGMENTS]).toEqual(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])
  })
})

describe('list_dir —— 输出层过滤落到真实结果', () => {
  test('平铺列举:read-deny 命中项与默认 .git 都被剔除,普通文件保留', async () => {
    writeFileSync(join(root, 'a.txt'), '')
    writeFileSync(join(root, '.env'), 'API_KEY=secret')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), '')

    // 无规则:.env 仍会被列出(list_dir 平铺此前无任何过滤),但默认 .git 被剔除。
    const noRule = await listDirTool.execute({}, ctxWith([]))
    expect(noRule.split('\n')).toEqual(['.env', 'a.txt'])

    // deny Read(.env):.env 被剔除。
    const denied = await listDirTool.execute({}, ctxWith([denyRule('.env')]))
    expect(denied.split('\n')).toEqual(['a.txt'])
  })

  test('递归树:read-deny 命中的整棵子目录消失,默认重目录仍显示 [skipped]', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'private'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.ts'), '')
    writeFileSync(join(root, 'private', 'notes.txt'), '')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '')

    const out = await listDirTool.execute({ recursive: true, max_depth: 3 }, ctxWith([denyRule('private/**')]))
    const lines = out.split('\n')
    expect(lines).toContain('node_modules/ [skipped]')
    expect(lines).toContain('src/')
    expect(lines).toContain('src/app.ts')
    // 整棵 private/ 被 read-deny 剔除:目录本身和内容都不出现。
    expect(lines.some(l => l.startsWith('private'))).toBe(false)
  })
})

describe('glob_files / grep_files —— 输出层过滤落到真实结果', () => {
  test('glob_files:read-deny 命中的文件从匹配里剔除', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'generated'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1')
    writeFileSync(join(root, 'generated', 'out.ts'), 'export const out = 1')

    const noRule = await globFilesTool.execute({ pattern: '**/*.ts' }, ctxWith([]))
    expect(noRule.split('\n').sort()).toEqual(['generated/out.ts', 'src/app.ts'])

    const denied = await globFilesTool.execute({ pattern: '**/*.ts' }, ctxWith([denyRule('generated/**')]))
    expect(denied.split('\n')).toEqual(['src/app.ts'])
  })

  test('grep_files:read-deny 命中的文件内容不出现在搜索结果', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'shown.ts'), 'const marker = 1\n')
    writeFileSync(join(root, 'src', 'hidden.ts'), 'const marker = 2\n')

    const out = await grepFilesTool.execute(
      { pattern: 'marker', include: '**/*.ts' },
      ctxWith([denyRule('**/hidden.ts')]),
    )
    expect(out).toContain('src/shown.ts:1:const marker = 1')
    expect(out).not.toContain('hidden.ts')
  })

  test('grep_files 显式文件 scope 也受输出层过滤(被 deny 的文件即使点名也不搜)', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'hidden.ts'), 'const marker = 9\n')

    const out = await grepFilesTool.execute(
      { pattern: 'marker', path: 'src/hidden.ts' },
      ctxWith([denyRule('**/hidden.ts')]),
    )
    expect(out).toBe('未找到匹配内容')
  })

  test('符号链接项按其路径名过滤(与 cc 基于路径名的 --glob 排除一致)', async () => {
    writeFileSync(join(root, 'real.txt'), 'plain')
    // 一个名为 .env 的符号链接:按名字命中 deny Read(.env) → 从列举里剔除。
    symlinkSync(join(root, 'real.txt'), join(root, '.env'))

    const listed = await listDirTool.execute({}, ctxWith([denyRule('.env')]))
    expect(listed.split('\n')).toEqual(['real.txt'])
  })
})
