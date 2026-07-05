# W3 · Harness 沙箱(双层)实现计划

> 📌 状态:🚧进行中 · 任务〈W3 Harness·沙箱〉· 2026-07-06 立
> **For agentic workers:** REQUIRED SUB-SKILL: 用 `superpowers:subagent-driven-development`(推荐)或 `superpowers:executing-plans` 逐任务执行。步骤用 `- [ ]` 勾选跟踪。
> 上级 spec:`docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`(§5 沙箱专章 = 本窗权威)。前序:W1 立项脚手架、W2 Harness 核心(`ts/docs/W2-harness-core-findings.md` 已留 W3 扩展位)。

**Goal:** 给 TS harness 补上"双层沙箱"——应用层跨平台 TOCTOU 路径护栏 + Mac/Linux OS 真沙箱(接 `@anthropic-ai/sandbox-runtime`),让 `run_command` 的写操作能被围栏在工作区内;Windows 首发走已有 app 护栏并留好 Job Object 接口(原生 helper 交 W3b)。

**Architecture:** 两层叠加,防的是"乖乖听话的 AI 手滑 / 被注入输入使坏"(§5 威胁模型),不是对抗性恶意软件。**第一层(应用层,跨平台,纯 TS)**在 W2 的 `resolveInWorkspace` 边界判定之前,先挡掉"校验时是路径 A、shell 执行时变成路径 B"的 TOCTOU 输入(UNC / `~user` / `$()``${}``%VAR%` 展开 / 写操作 glob / 删根)。**第二层(OS 真沙箱,平台分叉)**:Mac/Linux 直接用 Anthropic 公开包 `@anthropic-ai/sandbox-runtime`(mac=sandbox-exec+Seatbelt、linux=bwrap),种子"可写=工作区、网络放行",把 `run_command` 的命令包进 OS 盒子跑;Windows 首发只靠第一层 app 护栏 + 一个回退到明文 spawn 的 Job Object 接口占位(原生 helper.exe = W3b)。两层用一个 `Sandbox` 门面按平台分派,并把沙箱状态实时序列化进 `run_command` 的工具说明给模型看。

**Tech Stack:** TypeScript · Bun ≥ 1.3.13 · `bun test` · `@anthropic-ai/sandbox-runtime@^0.0.63`(唯一新依赖,§1 铁律预授权的公开包)· `node:` 内置(child_process/os/path)。

## Global Constraints

> 每个任务的要求都隐含包含本节。数值/口径逐字照 spec。

- **照 cc-haha 重写、借码 OK、别发整份源文件(owner 2026-07-06 定死 · 别再为此停下问)**:UNC/TOCTOU 正则、`isDangerousRemovalPath`、OS 沙箱 wrap 用法**借 cc-haha 的正则/命名/写法/结构进我们自己的文件即可**(§9「写法/命名照 cc-haha」);唯一红线 = **别把它整份 `.ts` 源文件原样当产品发 / 当文件拷进本仓库**。`~/Desktop/cc-haha-ref` 是参照。**装包例外**:`@anthropic-ai/sandbox-runtime` 是公开 npm 包,直接装直接用。
- **⚠️ 行为对齐(owner 唯一较真 · 全 harness 窗通用)**:照 cc-haha 写的**确定性逻辑**(路径校验/沙箱/危险命令)必须「**同输入→同决策**」——验收拿刁钻边界(`../escape` / `\\server\share` / `~root/.ssh` / `rm -rf *` 等)断言判得跟 cc-haha **一模一样**,别只测自己想到的用例。
- **Bun ≥ 1.3.13**;后端一律 **`bun test`**(用 Bun 全局,vitest 跑不了);跑命令前 `export PATH="$HOME/.bun/bin:$PATH"`。
- **`noUncheckedIndexedAccess: true`**:数组/`.at()` 取值是 `T | undefined`,测试里用 `!`/可选链。
- **可用 `node:` API**(child_process/os/path/fs):sidecar 要 Node+Bun 双运行时,别改成 Bun 专有 API。
- **产品红线不因换语言丢**:改文件前自动备份可回滚(W2 已有,别破坏)· 危险命令(删根/提权/格式化)直接拒 · `..` 越界抛错(W2 已有)。**审批闸/权限三档/完整危险命令分类器 = W4,本窗不做**;本窗的 `dangerousCommand` 仍只是红线兜底最小种子。
- **W3 沙箱姿态 = opt-in**:`Sandbox` 默认 `enabled=false`(照 cc-haha `sandbox.enabled` 默认关)。W3 只证明"启用时写围栏真生效";**"默认开 / 按命令决定要不要沙箱(shouldUseSandbox)/ 工作区内自动放行不弹确认 / 网络策略收紧" = W4**(§5:有了 OS 沙箱这层"才敢自动放行",而自动放行绑审批,是 W4)。
- **网络**:sandbox-runtime 网络是 allow-only、空 allowedDomains = 断网(会掐 npm/git/curl)。W3 种子只做**文件系统围栏**(allowWrite=[工作区]),网络用 `askCallback: async () => true` 放行,收紧交 W4。
- **macOS `/tmp` 是 `/private/tmp` 软链**:凡是拿 `mkdtempSync` 建的工作区跟 `pwd`/落盘路径比对,一律 `realpathSync(mkdtempSync(...))`,否则对不上(W2 踩过)。
- **测试分层照 W1**:纯逻辑单测进 `bun test`(跨平台绿);真起 OS 沙箱的行为验证进 `ts/scripts/smoke/sandbox.smoke.ts`(mac 上 `bun run smoke:sandbox` 跑),**不进 `bun test`**——保持 CI `bun test` 跨平台不挂。

---

## 文件结构(先锁分解)

**新增:**
- `ts/src/workspace/pathValidation.ts` — 应用层 TOCTOU 护栏(纯函数、平台可注入):`expandTilde` / `isVulnerableUncPath` / `isDangerousRemovalPath` / `PathValidationError` / `validatePath` / `FileOperation` 类型。
- `ts/src/workspace/pathValidation.test.ts`
- `ts/src/sandbox/osSandbox.ts` — Mac/Linux 包 `@anthropic-ai/sandbox-runtime`:`buildRuntimeConfig` / `isOsSandboxSupported` / `ensureInitialized` / `wrapArgv` / `resetOsSandbox`。
- `ts/src/sandbox/osSandbox.test.ts`
- `ts/src/sandbox/windowsLauncher.ts` — Windows Job Object 接口占位(W3 回退明文 + 日志;W3b 接原生 helper)。
- `ts/src/sandbox/sandbox.ts` — 平台分派门面 `Sandbox`:`isOsSandboxActive` / `wrapCommand` / `describeForPrompt`。
- `ts/src/sandbox/sandbox.test.ts`
- `ts/scripts/smoke/sandbox.smoke.ts` — mac 真起沙箱:工作区内写入成功 / 工作区外(home)写入被拒。
- `ts/docs/W3-sandbox-findings.md` — 本窗 findings + W3b 交接。

**修改:**
- `ts/src/workspace/workspace.ts` — `resolve(requested, operation)` 改经 `validatePath`(默认 `'read'` 保后向兼容);`backup` 不动。
- `ts/src/tools/fileReadTool.ts` / `listDirTool.ts` — `resolve(path, 'read')`。
- `ts/src/tools/fileWriteTool.ts` — `resolve(path, 'write')`。
- `ts/src/tools/dangerousCommand.ts` — 补 `rm *` / `rm /*` / 盘符根 / 命令内 UNC(红线种子,仍宁可漏杀交 W4)。
- `ts/src/tools/Tool.ts` — `ToolContext` 加 `sandbox?: Sandbox`。
- `ts/src/tools/runCommandTool.ts` — 经 `ctx.sandbox?.wrapCommand()` 包裹后 spawn;返回 null 则按原明文 `sh -c` 跑。
- `ts/src/tools/generalTools.ts` — `buildGeneralRegistry(opts?: { sandbox?: Sandbox })`,把 `sandbox.describeForPrompt()` 拼进 `run_command` 描述。
- `ts/src/harness/loop.ts` — `RunAgentLoopOptions` 加 `sandbox?`;`ctx` 带上 `sandbox`。
- `ts/package.json` — 加 `@anthropic-ai/sandbox-runtime` 依赖 + `smoke:sandbox` 脚本。

**依赖顺序**(保证每步收尾 `tsc` 尽量干净):Task 1→2→3(应用层,独立)→ Task 4(osSandbox,先 `bun add`)→ Task 5(门面 + win 占位)→ Task 6(Tool.ts/run_command/generalTools/loop 接线,此时 `Sandbox` 已存在)→ Task 7(smoke + 全绿)→ Task 8(findings)。

---

### Task 1: 应用层 TOCTOU 护栏(纯函数)

建 `pathValidation.ts` 的全部纯逻辑:`~` 展开、UNC 检测、删根检测、`validatePath` 编排。全部平台可注入(`platform`/`home` 参数),这样在 mac 上也能测 Windows 分支。

**Files:**
- Create: `ts/src/workspace/pathValidation.ts`
- Test: `ts/src/workspace/pathValidation.test.ts`
- 复用: `ts/src/workspace/pathBoundary.ts`(`resolveInWorkspace` / `WorkspaceBoundaryError`,W2 已有)

**Interfaces:**
- Consumes: `resolveInWorkspace(root, requested) → string`、`WorkspaceBoundaryError`(W2)。
- Produces:
  - `type FileOperation = 'read' | 'write' | 'create'`
  - `expandTilde(path: string, home?: string, platform?: NodeJS.Platform): string`
  - `isVulnerableUncPath(path: string, platform?: NodeJS.Platform): boolean`
  - `isDangerousRemovalPath(resolvedPath: string, home?: string): boolean`
  - `class PathValidationError extends Error { requested: string; reason: string }`
  - `validatePath(requested: string, opts: { root: string; operation: FileOperation; platform?: NodeJS.Platform; home?: string }): string`

- [ ] **Step 1: 写失败测试**

```ts
// ts/src/workspace/pathValidation.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandTilde,
  isDangerousRemovalPath,
  isVulnerableUncPath,
  PathValidationError,
  validatePath,
} from './pathValidation'
import { WorkspaceBoundaryError } from './pathBoundary'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'w3-pv-')))
const HOME = '/Users/tester'

describe('expandTilde', () => {
  test('~ 与 ~/ 展开到 home', () => {
    expect(expandTilde('~', HOME, 'darwin')).toBe(HOME)
    expect(expandTilde('~/a/b', HOME, 'darwin')).toBe(`${HOME}/a/b`)
  })
  test('~user 不展开(原样返回,交由 validatePath 拒)', () => {
    expect(expandTilde('~root/.ssh', HOME, 'darwin')).toBe('~root/.ssh')
  })
})

describe('isVulnerableUncPath', () => {
  test('win 上识别 \\\\server\\share 与 //server/share', () => {
    expect(isVulnerableUncPath('\\\\server\\share', 'win32')).toBe(true)
    expect(isVulnerableUncPath('//evil.com/x', 'win32')).toBe(true)
  })
  test('URL(https://)不误判为 UNC', () => {
    expect(isVulnerableUncPath('https://x.com/a', 'win32')).toBe(false)
  })
  test('非 win 平台一律 false(UNC 是 Windows 概念)', () => {
    expect(isVulnerableUncPath('\\\\server\\share', 'darwin')).toBe(false)
  })
})

describe('isDangerousRemovalPath', () => {
  test('根 / home / 盘符根 / 根直接子级 / * 命中', () => {
    expect(isDangerousRemovalPath('/', HOME)).toBe(true)
    expect(isDangerousRemovalPath(HOME, HOME)).toBe(true)
    expect(isDangerousRemovalPath('C:\\', HOME)).toBe(true)
    expect(isDangerousRemovalPath('/etc', HOME)).toBe(true)
    expect(isDangerousRemovalPath('*', HOME)).toBe(true)
    expect(isDangerousRemovalPath('/some/dir/*', HOME)).toBe(true)
  })
  test('工作区内深路径不命中', () => {
    expect(isDangerousRemovalPath(`${HOME}/proj/src/a.ts`, HOME)).toBe(false)
  })
})

describe('validatePath', () => {
  const base = { root: ROOT, home: HOME } as const

  test('普通相对路径放行,a/../b 停区内合法', () => {
    expect(validatePath('a/b.txt', { ...base, operation: 'read' })).toBe(join(ROOT, 'a/b.txt'))
    expect(validatePath('a/../b.txt', { ...base, operation: 'write' })).toBe(join(ROOT, 'b.txt'))
  })
  test('逃出工作区 → WorkspaceBoundaryError', () => {
    expect(() => validatePath('../escape', { ...base, operation: 'read' })).toThrow(WorkspaceBoundaryError)
  })
  test('UNC(win)→ PathValidationError', () => {
    expect(() => validatePath('\\\\srv\\c', { ...base, operation: 'read', platform: 'win32' })).toThrow(
      PathValidationError,
    )
  })
  test('~user 变体 → PathValidationError', () => {
    expect(() => validatePath('~root/.ssh/id_rsa', { ...base, operation: 'read' })).toThrow(PathValidationError)
  })
  test('shell 展开语法 $ % = → PathValidationError', () => {
    expect(() => validatePath('$HOME/x', { ...base, operation: 'read' })).toThrow(PathValidationError)
    expect(() => validatePath('%TEMP%\\x', { ...base, operation: 'read' })).toThrow(PathValidationError)
    expect(() => validatePath('=rg', { ...base, operation: 'read' })).toThrow(PathValidationError)
  })
  test('写/create 含 glob → 拒;读含 glob → 放行(工具按字面读)', () => {
    expect(() => validatePath('logs/*.txt', { ...base, operation: 'write' })).toThrow(PathValidationError)
    expect(validatePath('logs/a.txt', { ...base, operation: 'read' })).toBe(join(ROOT, 'logs/a.txt'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/workspace/pathValidation.test.ts`
Expected: FAIL —— `Cannot find module './pathValidation'`。

- [ ] **Step 3: 写实现**

```ts
// ts/src/workspace/pathValidation.ts
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { resolveInWorkspace } from './pathBoundary'

export type FileOperation = 'read' | 'write' | 'create'

const GLOB_PATTERN_REGEX = /[*?[\]{}]/
const WINDOWS_DRIVE_ROOT_REGEX = /^[A-Za-z]:\/?$/
const WINDOWS_DRIVE_CHILD_REGEX = /^[A-Za-z]:\/[^/]+$/

// UNC 检测(照 cc-haha readOnlyCommandValidation.containsVulnerableUncPath,自写):
// \\server\share · //server/share(排除 URL 的 (?<!:)) · 混合分隔 /\\server · \\/server
const UNC_PATTERNS: RegExp[] = [
  /\\\\[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
  /(?<!:)\/\/[^\s\\/]+(?:@(?:\d+|ssl))?(?:[\\/]|$|\s)/i,
  /\/\\{2,}[^\s\\/]/,
  /\\{2,}\/[^\s\\/]/,
]

export class PathValidationError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: string,
  ) {
    super(`路径校验失败：${reason}（${requested}）`)
    this.name = 'PathValidationError'
  }
}

/** 展开开头的 ~ 和 ~/(win 还含 ~\)到 home;~user/~+/~- 不展开(留待 validatePath 拒)。 */
export function expandTilde(
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (path === '~' || path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))) {
    return home + path.slice(1)
  }
  return path
}

/** Windows UNC 路径(可致凭据外泄);UNC 是 Windows 概念,非 win 平台恒 false。 */
export function isVulnerableUncPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false
  return UNC_PATTERNS.some(re => re.test(path))
}

/** 灾难级删除目标:根 / 盘符根 / home / 根直接子级 / 盘符直接子级 / `*` / `…/*`。 */
export function isDangerousRemovalPath(resolvedPath: string, home: string = homedir()): boolean {
  const fwd = resolvedPath.replace(/[\\/]+/g, '/')
  if (fwd === '*' || fwd.endsWith('/*')) return true
  const norm = fwd === '/' ? fwd : fwd.replace(/\/$/, '')
  if (norm === '/') return true
  if (WINDOWS_DRIVE_ROOT_REGEX.test(norm)) return true
  if (norm === home.replace(/[\\/]+/g, '/')) return true
  if (dirname(norm) === '/') return true
  if (WINDOWS_DRIVE_CHILD_REGEX.test(norm)) return true
  return false
}

/**
 * 应用层 TOCTOU 护栏(照 cc-haha pathValidation.validatePath 重写):在 resolveInWorkspace 边界判定之前,
 * 先挡掉 shell 执行时会"变身"的输入,消除"校验路径 A、执行读/写路径 B"的缺口。
 * 通过 → 返回工作区内绝对路径;TOCTOU 违规 → PathValidationError;逃出工作区 → WorkspaceBoundaryError。
 */
export function validatePath(
  requested: string,
  opts: { root: string; operation: FileOperation; platform?: NodeJS.Platform; home?: string },
): string {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  const cleaned = expandTilde(requested.replace(/^['"]|['"]$/g, ''), home, platform)

  if (isVulnerableUncPath(cleaned, platform)) {
    throw new PathValidationError(requested, 'UNC 网络路径需人工确认')
  }
  // expandTilde 已把 ~ / ~/ 变成绝对路径,残留以 ~ 开头的只剩 ~user/~+/~- 变体
  if (cleaned.startsWith('~')) {
    throw new PathValidationError(requested, '~user/~+/~- 波浪号变体需人工确认')
  }
  if (cleaned.includes('$') || cleaned.includes('%') || cleaned.startsWith('=')) {
    throw new PathValidationError(requested, 'shell 展开语法（$ % =）需人工确认')
  }
  if ((opts.operation === 'write' || opts.operation === 'create') && GLOB_PATTERN_REGEX.test(cleaned)) {
    throw new PathValidationError(requested, '写操作不允许 glob 通配，请给确切路径')
  }
  return resolveInWorkspace(opts.root, cleaned)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/workspace/pathValidation.test.ts`
Expected: PASS(全部用例绿)。

- [ ] **Step 5: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/src/workspace/pathValidation.ts ts/src/workspace/pathValidation.test.ts
git commit -m "feat(ts): W3 应用层 TOCTOU 护栏(UNC/~user/$展开/写禁glob/删根)"
```
Expected: `tsc --noEmit` exit 0。

---

### Task 2: 把 validatePath 接进 Workspace.resolve + 文件工具带上 operation

让 W2 已有的 `read/write/list` 三个文件工具走新护栏。`Workspace.resolve` 加 `operation` 参数(默认 `'read'` 保后向兼容),内部改调 `validatePath`。

**Files:**
- Modify: `ts/src/workspace/workspace.ts`
- Modify: `ts/src/tools/fileReadTool.ts` · `ts/src/tools/listDirTool.ts` · `ts/src/tools/fileWriteTool.ts`
- Test: `ts/src/workspace/workspace.test.ts`(W2 已有,新增用例)· `ts/src/tools/fileTools.test.ts`(W2 已有,新增用例)

**Interfaces:**
- Consumes: `validatePath` / `FileOperation`(Task 1)。
- Produces: `Workspace.resolve(requested: string, operation?: FileOperation): string`(签名从 `resolve(requested)` 扩成带可选 operation)。

- [ ] **Step 1: 写失败测试**(追加到 `ts/src/workspace/workspace.test.ts` 末尾)

```ts
import { PathValidationError } from './pathValidation'

test('resolve 写操作拒 glob;读操作放行', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ws-'))))
  expect(() => ws.resolve('out/*.txt', 'write')).toThrow(PathValidationError)
  expect(ws.resolve('out/a.txt', 'read')).toBe(join(ws.root, 'out/a.txt'))
})

test('resolve 默认 read、a/../b 停区内合法(后向兼容 W2)', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ws-'))))
  expect(ws.resolve('a/../b.txt')).toBe(join(ws.root, 'b.txt'))
})
```

追加到 `ts/src/tools/fileTools.test.ts`(用现有该文件的 import 风格;确认顶部已 import `PathValidationError`,没有则加 `import { PathValidationError } from '../workspace/pathValidation'`):

```ts
test('write_file 拒 $ 展开路径(TOCTOU)', async () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ft-'))))
  const ctx = { workspace: ws }
  await expect(fileWriteTool.execute({ path: '$HOME/evil.txt', content: 'x' }, ctx)).rejects.toThrow(
    PathValidationError,
  )
})
```
> 注:`fileTools.test.ts` 的 `Workspace`/`realpathSync`/`mkdtempSync`/`tmpdir`/`join`/`fileWriteTool` W2 已 import,沿用即可;缺哪个补哪个。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/workspace/workspace.test.ts src/tools/fileTools.test.ts`
Expected: FAIL —— `ws.resolve('out/*.txt', 'write')` 未抛(旧 resolve 不认 operation、不查 glob)。

- [ ] **Step 3: 改实现**

`ts/src/workspace/workspace.ts`——把 `resolve` 改经 `validatePath`(顶部 import 改动 + 方法体):

```ts
// 顶部 import：把 resolveInWorkspace 换成 validatePath + FileOperation
import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { type FileOperation, validatePath } from './pathValidation'
```

```ts
// 方法体（原 resolve）：
  resolve(requested: string, operation: FileOperation = 'read'): string {
    return validatePath(requested, { root: this.root, operation })
  }
```
> `resolveInWorkspace` 不再被 workspace.ts 直接引用(改由 pathValidation 内部调),`pathBoundary.ts` 与其单测保持不变。

`ts/src/tools/fileReadTool.ts`——`resolve` 带 `'read'`:

```ts
    return await readFile(ctx.workspace.resolve(input.path, 'read'), 'utf8')
```

`ts/src/tools/listDirTool.ts`——`resolve` 带 `'read'`:

```ts
    const abs = ctx.workspace.resolve(input?.path ?? '.', 'read')
```

`ts/src/tools/fileWriteTool.ts`——`resolve` 带 `'write'`:

```ts
    const abs = ctx.workspace.resolve(input.path, 'write')
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test`
Expected: PASS(新用例绿 + W2 全部旧用例不回归)。

- [ ] **Step 5: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/src/workspace/workspace.ts ts/src/tools/fileReadTool.ts ts/src/tools/listDirTool.ts ts/src/tools/fileWriteTool.ts ts/src/workspace/workspace.test.ts ts/src/tools/fileTools.test.ts
git commit -m "feat(ts): W3 文件工具接应用层护栏(resolve 带 operation + 写禁glob/$展开)"
```

---

### Task 3: 强化 run_command 危险命令红线种子

`run_command` 拿的是整条 shell 命令(不是单个路径),Task 1/2 的路径护栏管不到命令字符串本身。这里给 W2 的 `dangerousCommand` 补 §5 点名的命令级红线:`rm *` / `rm /*` / `rm 盘符根` / 命令内 UNC。**仍是红线兜底最小种子,宁可漏杀交 W4**,别在这做完整分类器。

**Files:**
- Modify: `ts/src/tools/dangerousCommand.ts`
- Test: `ts/src/tools/runCommandTool.test.ts`(W2 已有,新增用例)

**Interfaces:**
- Consumes: 无新增。
- Produces: `isDangerousCommand(command: string): boolean`(签名不变,命中面扩大)。

- [ ] **Step 1: 写失败测试**(追加到 `ts/src/tools/runCommandTool.test.ts`)

```ts
import { isDangerousCommand } from './dangerousCommand'

describe('dangerousCommand W3 补强', () => {
  test('rm 通配/盘符根命中', () => {
    expect(isDangerousCommand('rm -rf *')).toBe(true)
    expect(isDangerousCommand('rm -rf /*')).toBe(true)
    expect(isDangerousCommand('rm -rf C:\\')).toBe(true)
  })
  test('命令内 UNC 命中', () => {
    expect(isDangerousCommand('copy \\\\evil\\share\\x .')).toBe(true)
  })
  test('工作区内正常命令不误杀', () => {
    expect(isDangerousCommand('rm -rf build/cache')).toBe(false)
    expect(isDangerousCommand('npm run build')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/runCommandTool.test.ts`
Expected: FAIL —— `rm -rf *` 等未命中(W2 种子只挡 `rm -rf / | ~ | $HOME`)。

- [ ] **Step 3: 改实现**(在 `DANGEROUS_PATTERNS` 数组追加 3 条)

```ts
// ts/src/tools/dangerousCommand.ts —— 在数组末尾、闭合 ] 之前追加：
  /\brm\s+(-[a-z]*\s+)*(\*|\/\*)(\s|$)/, // rm * | rm /*（通配删大片）
  /\brm\s+(-[a-z]*\s+)*[A-Za-z]:[\\/]?(\s|$)/i, // rm C:\ | rm D:/（盘符根）
  /\\\\[^\s\\/]+[\\/]/, // 命令内 UNC \\server\...（凭据外泄面）
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/runCommandTool.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/src/tools/dangerousCommand.ts ts/src/tools/runCommandTool.test.ts
git commit -m "feat(ts): W3 危险命令红线补强(rm通配/盘符根/命令内UNC)"
```

---

### Task 4: OS 沙箱包装层(接 @anthropic-ai/sandbox-runtime)

装公开包并封一层薄适配 `osSandbox.ts`:从工作区种出 `SandboxRuntimeConfig`(可写=工作区+默认写目录、网络放行)、初始化、把命令 `wrapWithSandboxArgv` 成可 spawn 的 `{argv, env}`。**第一步先验包在 Bun 下能加载**(Phase-0 式风险闸)。

**Files:**
- Modify: `ts/package.json`(加依赖)
- Create: `ts/src/sandbox/osSandbox.ts`
- Test: `ts/src/sandbox/osSandbox.test.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/sandbox-runtime` 的 `SandboxManager`(单例)、`getDefaultWritePaths()`、`type SandboxRuntimeConfig`。
- Produces:
  - `buildRuntimeConfig(seed: { writablePaths: string[]; denyWritePaths?: string[] }): SandboxRuntimeConfig`
  - `isOsSandboxSupported(platform?: NodeJS.Platform): boolean`
  - `ensureInitialized(config: SandboxRuntimeConfig): Promise<void>`
  - `wrapArgv(command: string, signal?: AbortSignal): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>`
  - `resetOsSandbox(): Promise<void>`

- [ ] **Step 1: 装依赖 + 验 Bun 加载(风险闸)**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun add @anthropic-ai/sandbox-runtime@^0.0.63
bun -e "import('@anthropic-ai/sandbox-runtime').then(m => console.log('exports:', Object.keys(m).slice(0, 12).join(',')))"
```
Expected: 打印出含 `SandboxManager,SandboxViolationStore,...` 的导出名(证明包在 Bun 下能加载)。
**若这步炸**(Bun 加载不了):记进 findings,回退方案 = 不用库 API、改 spawn 包自带的 `srt` CLI(`node_modules/.bin/srt`,写临时 `~/.srt-settings.json` 传配置);本任务其余步骤按"spawn srt"重构 `wrapArgv`。**Task 4 起不下去别硬扛,先把这条结论回报。**

- [ ] **Step 2: 写失败测试**

```ts
// ts/src/sandbox/osSandbox.test.ts
import { describe, expect, test } from 'bun:test'
import { buildRuntimeConfig, isOsSandboxSupported } from './osSandbox'

describe('buildRuntimeConfig', () => {
  test('可写含工作区根,网络默认空(放行靠 askCallback)', () => {
    const cfg = buildRuntimeConfig({ writablePaths: ['/tmp/w3-proj'] })
    expect(cfg.filesystem.allowWrite).toContain('/tmp/w3-proj')
    expect(cfg.filesystem.denyWrite).toEqual([])
    expect(cfg.network.allowedDomains).toEqual([])
  })
  test('denyWritePaths 透传', () => {
    const cfg = buildRuntimeConfig({ writablePaths: ['/tmp/p'], denyWritePaths: ['/tmp/p/.secret'] })
    expect(cfg.filesystem.denyWrite).toContain('/tmp/p/.secret')
  })
})

describe('isOsSandboxSupported', () => {
  test('win32 恒 false(OS 层不支持 Windows,走 app 护栏)', () => {
    expect(isOsSandboxSupported('win32')).toBe(false)
  })
  test('darwin 上为 true(本机是 mac)', () => {
    expect(isOsSandboxSupported('darwin')).toBe(true)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/sandbox/osSandbox.test.ts`
Expected: FAIL —— `Cannot find module './osSandbox'`。

- [ ] **Step 4: 写实现**

```ts
// ts/src/sandbox/osSandbox.ts
import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'

export interface OsSandboxSeed {
  writablePaths: string[]
  denyWritePaths?: string[]
}

/**
 * 从工作区种出运行时配置。写=allow-only(只放工作区 + 包自带的默认写目录如 /tmp、/dev/null,
 * 让常见命令能跑);读=默认全放;网络=空 allowedDomains(实际放行靠 initialize 的 askCallback=allow,
 * W3 只做文件系统围栏,网络收紧交 W4)。
 */
export function buildRuntimeConfig(seed: OsSandboxSeed): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: Array.from(new Set([...seed.writablePaths, ...getDefaultWritePaths()])),
      denyWrite: seed.denyWritePaths ?? [],
      allowRead: [],
      denyRead: [],
    },
    network: { allowedDomains: [], deniedDomains: [] },
  }
}

/** OS 真沙箱仅 mac/linux;Windows 走 app 护栏(见 sandbox.ts)。 */
export function isOsSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin' && platform !== 'linux') return false
  return SandboxManager.isSupportedPlatform()
}

let initialized = false

export async function ensureInitialized(config: SandboxRuntimeConfig): Promise<void> {
  if (initialized) {
    SandboxManager.updateConfig(config)
    return
  }
  // askCallback 恒 allow = 网络放行(W3 姿态);enableLogMonitor=false 减开销。
  await SandboxManager.initialize(config, async () => true, false)
  initialized = true
}

export async function wrapArgv(
  command: string,
  signal?: AbortSignal,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  return SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, signal)
}

export async function resetOsSandbox(): Promise<void> {
  initialized = false
  await SandboxManager.reset()
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/sandbox/osSandbox.test.ts`
Expected: PASS。
> 注:`SandboxRuntimeConfig` 若还含其它必填字段导致 `buildRuntimeConfig` 返回值 tsc 报错,按装好的 `.d.ts` 补齐(如 `credentials`/`windows` 多为可选);以 `node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.d.ts` 为准。

- [ ] **Step 6: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/package.json ts/bun.lock ts/src/sandbox/osSandbox.ts ts/src/sandbox/osSandbox.test.ts
git commit -m "feat(ts): W3 OS沙箱包装层(接 @anthropic-ai/sandbox-runtime · 工作区写围栏)"
```

---

### Task 5: 平台分派门面 Sandbox + Windows Job Object 接口占位

`sandbox.ts` 一个 `Sandbox` 门面按平台分派:mac/linux 启用时经 osSandbox 包命令、返回 `{argv,env}`;不启用/其它平台返回 `null`(明文 spawn);Windows 走 `windowsLauncher`(W3 回退明文 + 日志,W3b 接原生 Job Object)。并给模型看的 `describeForPrompt()`。

**Files:**
- Create: `ts/src/sandbox/windowsLauncher.ts`
- Create: `ts/src/sandbox/sandbox.ts`
- Test: `ts/src/sandbox/sandbox.test.ts`

**Interfaces:**
- Consumes: `isOsSandboxSupported` / `buildRuntimeConfig` / `ensureInitialized` / `wrapArgv`(Task 4);`type Workspace`(W2)。
- Produces:
  - `class WindowsJobObjectLauncher { available(): boolean; wrap(command: string, opts: { signal?: AbortSignal }): null }`
  - `interface WrappedCommand { argv: string[]; env: NodeJS.ProcessEnv }`
  - `class Sandbox`:
    - `constructor(opts: { workspace: Workspace; enabled?: boolean; platform?: NodeJS.Platform })`
    - `isOsSandboxActive(): boolean`
    - `wrapCommand(command: string, opts?: { signal?: AbortSignal }): Promise<WrappedCommand | null>`
    - `describeForPrompt(): string`

- [ ] **Step 1: 写失败测试**

```ts
// ts/src/sandbox/sandbox.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { Sandbox } from './sandbox'

function ws() {
  return new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-sb-'))))
}

describe('Sandbox 分派', () => {
  test('默认 opt-in 关闭 → OS 沙箱不激活、wrapCommand 返回 null(明文跑)', async () => {
    const sb = new Sandbox({ workspace: ws(), platform: 'darwin' })
    expect(sb.isOsSandboxActive()).toBe(false)
    expect(await sb.wrapCommand('echo hi')).toBeNull()
  })
  test('darwin + enabled → OS 沙箱激活', () => {
    const sb = new Sandbox({ workspace: ws(), enabled: true, platform: 'darwin' })
    expect(sb.isOsSandboxActive()).toBe(true)
  })
  test('win32 + enabled → OS 层不激活(走 app 护栏),wrapCommand 返回 null', async () => {
    const sb = new Sandbox({ workspace: ws(), enabled: true, platform: 'win32' })
    expect(sb.isOsSandboxActive()).toBe(false)
    expect(await sb.wrapCommand('dir')).toBeNull()
  })
  test('describeForPrompt 随状态给大白话:激活提"工作区可写围栏",win 提 "Job Object 待启用"', () => {
    expect(new Sandbox({ workspace: ws(), enabled: true, platform: 'darwin' }).describeForPrompt()).toContain('工作区')
    expect(new Sandbox({ workspace: ws(), platform: 'win32' }).describeForPrompt()).toContain('Job Object')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/sandbox/sandbox.test.ts`
Expected: FAIL —— `Cannot find module './sandbox'`。

- [ ] **Step 3: 写实现**

```ts
// ts/src/sandbox/windowsLauncher.ts
/**
 * Windows Job Object launcher 的接口占位(W3)。
 * W3 首发:Windows 靠应用层护栏(路径沙箱 + 改前备份 + 审批闸)保护,Job Object 从这里接入。
 * W3b:CI 交叉编译 Rust helper.exe(照 Codex windows-sandbox 思路,见主文档 §5),wrap() 起子进程装进
 *      Job Object(免管理员、进程/资源围栏)。届时 available() 返 true、wrap() 返回 {argv,env}。
 */
export class WindowsJobObjectLauncher {
  available(): boolean {
    return false // W3b 起变 true
  }

  wrap(command: string, _opts: { signal?: AbortSignal }): null {
    // W3:helper 未接入,回退明文 spawn(应用层护栏仍生效)。留痕便于 W3b / 真机排查。
    if (process.env.DESKTOP_DEBUG) {
      console.error(`[sandbox] Windows Job Object 未接入，命令按应用层护栏直跑：${command}`)
    }
    return null
  }
}
```

```ts
// ts/src/sandbox/sandbox.ts
import type { Workspace } from '../workspace/workspace'
import { buildRuntimeConfig, ensureInitialized, isOsSandboxSupported, wrapArgv } from './osSandbox'
import { WindowsJobObjectLauncher } from './windowsLauncher'

export interface WrappedCommand {
  argv: string[]
  env: NodeJS.ProcessEnv
}

/**
 * 双层沙箱门面(§5)。wrapCommand 返回 {argv,env} = 包进 OS 盒子跑;返回 null = 按明文命令跑(plain spawn)。
 * W3 姿态:enabled 默认 false(opt-in,照 cc-haha);"默认开 / 按命令决定沙箱 / 自动放行" = W4。
 */
export class Sandbox {
  readonly workspace: Workspace
  private readonly enabled: boolean
  private readonly platform: NodeJS.Platform
  private readonly winLauncher = new WindowsJobObjectLauncher()
  private initialized = false

  constructor(opts: { workspace: Workspace; enabled?: boolean; platform?: NodeJS.Platform }) {
    this.workspace = opts.workspace
    this.enabled = opts.enabled ?? false
    this.platform = opts.platform ?? process.platform
  }

  isOsSandboxActive(): boolean {
    return this.enabled && isOsSandboxSupported(this.platform)
  }

  async wrapCommand(command: string, opts: { signal?: AbortSignal } = {}): Promise<WrappedCommand | null> {
    if (this.isOsSandboxActive()) {
      if (!this.initialized) {
        await ensureInitialized(buildRuntimeConfig({ writablePaths: [this.workspace.root] }))
        this.initialized = true
      }
      return await wrapArgv(command, opts.signal)
    }
    if (this.platform === 'win32') {
      return this.winLauncher.wrap(command, opts) // W3:null(回退明文);W3b:Job Object
    }
    return null
  }

  /** 序列化进 run_command 工具说明给模型看(§5:沙箱配置实时给模型)。 */
  describeForPrompt(): string {
    if (this.isOsSandboxActive()) {
      return `命令在 OS 沙箱中运行：可写目录仅限工作区（${this.workspace.root}），越界写入会被系统拒绝。`
    }
    if (this.platform === 'win32') {
      return '命令在本机直接运行（受应用层护栏：路径沙箱 + 改前备份 + 审批闸）。Windows Job Object 隔离待后续启用。'
    }
    return '命令在本机直接运行（受应用层护栏：路径沙箱 + 改前备份 + 审批闸）。'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/sandbox/sandbox.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/src/sandbox/windowsLauncher.ts ts/src/sandbox/sandbox.ts ts/src/sandbox/sandbox.test.ts
git commit -m "feat(ts): W3 平台分派门面 Sandbox + Windows JobObject 接口占位"
```

---

### Task 6: 把 Sandbox 接进 run_command + ToolContext + 工具说明

`ToolContext` 加 `sandbox?`;`run_command` 拿 `ctx.sandbox` 包裹命令后 spawn(返回 null 走原明文 `sh -c`);`buildGeneralRegistry` 把 `describeForPrompt()` 拼进 `run_command` 描述;`loop.ts` 把 `sandbox` 透传进 `ctx`。

**Files:**
- Modify: `ts/src/tools/Tool.ts`
- Modify: `ts/src/tools/runCommandTool.ts`
- Modify: `ts/src/tools/generalTools.ts`
- Modify: `ts/src/harness/loop.ts`
- Test: `ts/src/tools/runCommandTool.test.ts` · `ts/src/tools/generalTools.test.ts`(W2 已有,新增用例)

**Interfaces:**
- Consumes: `class Sandbox` / `WrappedCommand`(Task 5)。
- Produces:
  - `ToolContext` 增字段 `sandbox?: Sandbox`
  - `buildGeneralRegistry(opts?: { sandbox?: Sandbox }): ToolRegistry`(签名从无参扩成可选 opts)
  - `RunAgentLoopOptions` 增字段 `sandbox?: Sandbox`

- [ ] **Step 1: 写失败测试**

追加到 `ts/src/tools/runCommandTool.test.ts`(用一个假 Sandbox 只实现 `wrapCommand`,把命令换成确定性 argv,验 run_command 真的用了包裹后的 argv):

```ts
import { runCommandTool } from './runCommandTool'
import { Workspace } from '../workspace/workspace'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('run_command 用 sandbox 包裹后的 argv 跑(返回 {argv,env})', async () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
  const fakeSandbox = {
    async wrapCommand() {
      return { argv: ['printf', 'WRAPPED'], env: {} as NodeJS.ProcessEnv }
    },
  }
  const out = await runCommandTool.execute({ command: 'echo IGNORED' }, {
    workspace: ws,
    sandbox: fakeSandbox as unknown as import('../sandbox/sandbox').Sandbox,
  })
  expect(out).toContain('WRAPPED')
})

test('run_command 无 sandbox 时按明文命令跑(W2 行为不回归)', async () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
  const out = await runCommandTool.execute({ command: 'echo PLAIN' }, { workspace: ws })
  expect(out).toContain('PLAIN')
})
```

追加到 `ts/src/tools/generalTools.test.ts`:

```ts
import { Sandbox } from '../sandbox/sandbox'
import { Workspace } from '../workspace/workspace'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('传 sandbox 时 run_command 描述带上沙箱说明', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-gr-'))))
  const reg = buildGeneralRegistry({ sandbox: new Sandbox({ workspace: ws, enabled: true, platform: 'darwin' }) })
  const spec = reg.specs().find(s => s.name === 'run_command')!
  expect(spec.description).toContain('工作区')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test src/tools/runCommandTool.test.ts src/tools/generalTools.test.ts`
Expected: FAIL —— `ToolContext` 无 `sandbox` 字段(tsc/运行报错)、`buildGeneralRegistry` 不认 opts。

- [ ] **Step 3: 改实现**

`ts/src/tools/Tool.ts`——`ToolContext` 加 `sandbox?`(顶部加 import):

```ts
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'

// ...

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
  sandbox?: Sandbox
}
```

`ts/src/tools/runCommandTool.ts`——包裹后 spawn(整文件替换):

```ts
import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './Tool'
import type { WrappedCommand } from '../sandbox/sandbox'
import { isDangerousCommand } from './dangerousCommand'

const DEFAULT_TIMEOUT_MS = 30_000

export const runCommandTool: Tool<{ command: string }> = {
  name: 'run_command',
  description: 'Run a shell command with the workspace as the working directory. Input: { command }.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!input || typeof input.command !== 'string') throw new Error('run_command 需要 string 参数 command')
    if (isDangerousCommand(input.command)) throw new Error(`拒绝执行危险命令：${input.command}`)
    const wrapped = ctx.sandbox ? await ctx.sandbox.wrapCommand(input.command, { signal: ctx.signal }) : null
    return await runInWorkspace(input.command, ctx, wrapped)
  },
}

function runInWorkspace(command: string, ctx: ToolContext, wrapped: WrappedCommand | null): Promise<string> {
  const isWin = process.platform === 'win32'
  // 包裹后:直接 spawn 沙箱给的 argv/env（免二次 shell）；未包裹:原明文 sh -c / cmd /c。
  const child = wrapped
    ? spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: ctx.workspace.root,
        env: { ...process.env, ...wrapped.env },
      })
    : isWin
      ? spawn('cmd', ['/c', command], { cwd: ctx.workspace.root })
      : spawn('sh', ['-c', command], { cwd: ctx.workspace.root })
  return new Promise<string>(resolvePromise => {
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TIMEOUT_MS)
    const onSignal = () => child.kill('SIGKILL')
    ctx.signal?.addEventListener('abort', onSignal, { once: true })
    child.stdout?.on('data', d => (out += d.toString()))
    child.stderr?.on('data', d => (out += d.toString()))
    child.on('error', err => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(`命令启动失败：${err.message}`)
    })
    child.on('close', code => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(code === 0 ? out.trim() : `${out.trim()}\n[退出码 ${code}]`)
    })
  })
}
```

`ts/src/tools/generalTools.ts`——`buildGeneralRegistry` 收 sandbox、拼描述:

```ts
import { ToolRegistry } from './registry'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'
import type { Sandbox } from '../sandbox/sandbox'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域层(billiards)是后续窗。 */
export function buildGeneralRegistry(opts: { sandbox?: Sandbox } = {}): ToolRegistry {
  const runCmd = opts.sandbox
    ? { ...runCommandTool, description: `${runCommandTool.description}\n${opts.sandbox.describeForPrompt()}` }
    : runCommandTool
  return new ToolRegistry([fileReadTool, fileWriteTool, listDirTool, runCmd])
}
```

`ts/src/harness/loop.ts`——透传 sandbox(改两处:`RunAgentLoopOptions` 加字段、`ctx` 带上):

```ts
// 顶部 import 追加：
import type { Sandbox } from '../sandbox/sandbox'
```
```ts
// RunAgentLoopOptions 加字段：
  signal?: AbortSignal
  sandbox?: Sandbox
```
```ts
// ctx 构造（原 loop.ts:25）：
  const ctx: ToolContext = { workspace, signal: opts.signal, sandbox: opts.sandbox }
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun test`
Expected: PASS(新用例 + W2/W3 全部旧用例不回归)。

- [ ] **Step 5: typecheck + 提交**

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
git add ts/src/tools/Tool.ts ts/src/tools/runCommandTool.ts ts/src/tools/generalTools.ts ts/src/harness/loop.ts ts/src/tools/runCommandTool.test.ts ts/src/tools/generalTools.test.ts
git commit -m "feat(ts): W3 Sandbox 接进 run_command/ToolContext/loop + 沙箱说明入工具描述"
```

---

### Task 7: mac 真机 smoke(写围栏真生效)+ 全绿收口

单测都是纯逻辑/假沙箱,**真起 OS 沙箱、验"工作区外写被拒"的行为**必须在 mac 上真跑一次(照 W1 smoke 脚本模式,不进 `bun test`,保 CI 跨平台绿)。这是 W3 的核心验收门。

**Files:**
- Create: `ts/scripts/smoke/sandbox.smoke.ts`
- Modify: `ts/package.json`(加 `smoke:sandbox` 脚本)

**Interfaces:**
- Consumes: `Workspace`(W2)· `Sandbox`(Task 5)。
- Produces: 无(脚本;`process.exit(1)` 表失败)。

- [ ] **Step 1: 写 smoke 脚本**

```ts
// ts/scripts/smoke/sandbox.smoke.ts
// mac 真起 OS 沙箱:工作区内写入应成功;工作区外(home)写入应被系统拒绝(写围栏生效)。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sandbox } from '../../src/sandbox/sandbox'
import { Workspace } from '../../src/workspace/workspace'

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return new Promise(res => {
    const c = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env } })
    c.on('close', code => res(code ?? -1))
    c.on('error', () => res(-1))
  })
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'w3-smoke-')))
const ws = new Workspace(root)
const sb = new Sandbox({ workspace: ws, enabled: true })

if (!sb.isOsSandboxActive()) {
  console.error('✗ OS 沙箱未激活(本机应为 mac/linux 且依赖就绪)——检查 checkDependencies')
  process.exit(1)
}

const insidePath = join(root, 'inside.txt')
const outsidePath = join(homedir(), `w3-escape-${process.pid}.txt`)

// 1) 工作区内写入 → 应成功
const insideWrap = await sb.wrapCommand(`printf hi > ${insidePath}`)
await run(insideWrap!.argv, insideWrap!.env, root)
const insideOk = existsSync(insidePath)

// 2) 工作区外(home)写入 → 应被拒(文件不该出现)
const outsideWrap = await sb.wrapCommand(`printf hi > ${outsidePath}`)
await run(outsideWrap!.argv, outsideWrap!.env, root)
const outsideBlocked = !existsSync(outsidePath)
if (existsSync(outsidePath)) rmSync(outsidePath) // 万一没拦住,清掉别留脏文件

console.log(`工作区内写入成功: ${insideOk}`)
console.log(`工作区外写入被拒: ${outsideBlocked}`)
if (insideOk && outsideBlocked) {
  console.log('✓ W3 OS 沙箱写围栏 smoke 通过')
  process.exit(0)
}
console.error('✗ W3 沙箱 smoke 失败(写围栏未按预期)')
process.exit(1)
```

`ts/package.json` scripts 追加:

```json
    "smoke:sandbox": "bun run scripts/smoke/sandbox.smoke.ts",
```

- [ ] **Step 2: mac 上真跑 smoke**

Run: `cd ts && export PATH="$HOME/.bun/bin:$PATH" && bun run smoke:sandbox`
Expected(mac):
```
工作区内写入成功: true
工作区外写入被拒: true
✓ W3 OS 沙箱写围栏 smoke 通过
```
**若"工作区外写入被拒: false"**(没拦住):说明种子/初始化没生效,进 systematic-debugging——查 `checkDependencies().errors`、`buildRuntimeConfig` 的 allowWrite 是否真只含工作区、`wrapWithSandboxArgv` 返回的 argv 是否真是 `sandbox-exec …`。把实际现象记进 findings。**别把"没拦住"当通过。**

- [ ] **Step 3: 全量回归 + typecheck**

Run:
```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun test
bun run typecheck
```
Expected: `bun test` 全绿(W1+W2+W3 单测,新增沙箱/校验用例)· `tsc --noEmit` exit 0。

- [ ] **Step 4: 提交**

```bash
git add ts/scripts/smoke/sandbox.smoke.ts ts/package.json
git commit -m "feat(ts): W3 mac 真机 smoke — OS 沙箱写围栏(工作区内通/工作区外拒)"
```

---

### Task 8: findings 文档 + 验收门 + W3b 交接

按主文档 §10 文档规约:写本窗 findings,给 W3b(Windows 原生 Job Object)留硬交接,更新 W2 findings 的"下一窗"指针。

**Files:**
- Create: `ts/docs/W3-sandbox-findings.md`
- Modify: `ts/docs/W2-harness-core-findings.md`(把末尾"下一窗=W3"更新为"W3 已建、下一窗见 §4.5")

- [ ] **Step 1: 写 findings**(`ts/docs/W3-sandbox-findings.md`)——至少覆盖:
  - 建了什么(应用层护栏 / OS 沙箱包装 / 门面 / win 占位 / smoke)的文件表;
  - 关键决策(为何 opt-in 默认关、为何网络放行只做文件围栏、为何 wrapArgv 不走二次 shell、Bun 加载 sandbox-runtime 的实测结论);
  - **W3 明确没做**(Windows 原生 Job Object helper / 网络收紧 / shouldUseSandbox / 自动放行 → W4/W3b);
  - 坑(mac `/private/tmp` 软链 · sandbox-runtime 依赖检查在 linux 需 bwrap+socat · `getDefaultWritePaths` 会放开 /tmp 故 smoke 用 home 作越界目标);
  - **给 W3b 的硬交接**:原生 helper.exe 照 Codex windows-sandbox 思路(`CreateRestrictedToken` 二期、W3b 先 `Job Object` 免管理员)· CI 交叉编译各平台 `.node`/`.exe` · `WindowsJobObjectLauncher.available()`/`wrap()` 是接入点 · 真机验放 W14;
  - 复跑命令(`bun test` / `bun run typecheck` / `bun run smoke:sandbox`)。

- [ ] **Step 2: 更新 W2 findings 指针**

`ts/docs/W2-harness-core-findings.md` 末尾"下一窗 = W3 双层沙箱…"改成:"W3 双层沙箱已建(见 `W3-sandbox-findings.md`);下一窗按主文档 §4.5(W4 审批权限/定向/压缩/子代理/skills 或 W3b Windows 原生 Job Object)。"

- [ ] **Step 3: 提交**

```bash
git add ts/docs/W3-sandbox-findings.md ts/docs/W2-harness-core-findings.md
git commit -m "docs(ts): W3 findings — 双层沙箱决策与坑 + W3b Windows原生交接"
```

- [ ] **Step 4: 过验收门(收窗前 `verification-before-completion` 确认)**

对照主文档 §5 + Phase-1 验收门,逐条确认(**跑命令看输出,别只断言**):
- [ ] `bun test` 全绿(含 W3 新单测);`bun run typecheck` exit 0。
- [ ] `bun run smoke:sandbox` 在 mac 上:工作区内写成功 + 工作区外写被拒(**OS 沙箱越界被挡**,§5 核心)。
- [ ] 应用层护栏:`write_file` 拒 `$HOME/x`/`~root/x`/glob(TOCTOU 单测绿)。
- [ ] `run_command` 危险命令红线:`rm -rf *` / 盘符根 / 命令内 UNC 被拒。
- [ ] 沙箱状态**实时序列化进 `run_command` 工具说明**(generalTools 单测:描述含"工作区")。
- [ ] Windows 分支:`isOsSandboxActive()` 为 false、走 app 护栏、`describeForPrompt` 提"Job Object 待启用"(单测绿);原生 helper 明确交 W3b、不在本窗冒充已测。
- [ ] 不搬 cc-haha 源码(护栏正则/isDangerousRemovalPath/wrap 用法均自写);唯一新依赖 = 公开包 `@anthropic-ai/sandbox-runtime`。
- [ ] W2 改文件前备份红线未被破坏(`fileTools.test.ts` 备份用例仍绿)。

- [ ] **Step 5: 收尾**

用 `superpowers:finishing-a-development-branch`:本窗在 `ts-harness-rewrite` 分支持续(与 W1/W2 同分支,不新开),把本计划文档 banner 标 `📦历史` 挪 `docs/归档/`(照主文档文档规约)、findings 已进 `ts/docs/`、更新记忆(见下)。**push/并 main 由 owner 决定**(默认只本地,照 W1/W2)。

---

## Self-Review(对照 §5 spec 自查)

**1. §5 覆盖:**
- 第一层应用层(路径校验 + 越界拦 + TOCTOU:UNC/`~user`/`$``%``=`展开/写禁 glob/删根)→ Task 1/2/3 ✅
- 第二层 Mac/Linux OS 真沙箱(装 `@anthropic-ai/sandbox-runtime`、种子"可写=工作区")→ Task 4 ✅
- 沙箱配置实时序列化进工具说明 → Task 6(`describeForPrompt` 入 run_command 描述)✅
- Windows 首发 = app 护栏 + Job Object 起步 → Task 5(app 护栏由 Task 1-3 跨平台生效 + Job Object 接口占位);**原生 helper.exe = W3b**(owner 2026-07-06 拍板拆半窗,见计划头)✅
- "有了 OS 沙箱才敢工作区内自动放行" → 明确标注属 **W4**(审批闸),本窗只建机制 + 证明写围栏生效 ✅
- 版本自核(`npm view … version`)→ 已核实 `0.0.63`,Task 4 装 `^0.0.63` ✅

**2. 占位扫描:** 无 "TODO/待补/略"——每步给了确切代码/命令/预期输出。`WindowsJobObjectLauncher` 的空实现是**有意的接口占位**(W3b 接入点),非占位符,已在 §5 决策 + Task 5 注释说明。

**3. 类型一致性:** `FileOperation`(Task1 产 → Task2 用)· `Sandbox.wrapCommand → WrappedCommand | null`(Task5 产 → Task6 消费,run_command 判 null 走明文)· `buildGeneralRegistry(opts?)`(Task6 扩签名,W2 无参调用仍兼容——`server/index.ts` 若调 `buildGeneralRegistry()` 不受影响)· `ToolContext.sandbox?`(可选,W2 现有构造 `{workspace,signal}` 不破)· `RunAgentLoopOptions.sandbox?`(可选,W2 调用不破)。

**4. 风险已在计划内兜:**
- **sandbox-runtime 在 Bun 下能否加载** = Task 4 Step 1 风险闸,炸了退 `srt` CLI(已写回退)。
- **网络默认断网** = 已定 W3 只做文件围栏 + askCallback 放行,收紧交 W4(Global Constraints 写明)。
- **写围栏真不真生效** = Task 7 mac smoke 是硬门,"没拦住"不算过。
