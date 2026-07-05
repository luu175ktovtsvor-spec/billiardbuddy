# W2 · Harness 核心（主循环 + 工具框架 + 文件夹工作区 + `<env>` 注入）Implementation Plan

> 📌 状态:✅建设完成(本地分支 ts-harness-rewrite)· 待 owner 合 main 后按规约挪 docs/归档/ · 2026-07-06
> 成果:10 Task 全过,全量 `bun test` 43 pass / 0 fail、`tsc --noEmit` 0 错;findings 见 `ts/docs/W2-harness-core-findings.md`。9 个功能提交(ad624cd..8c8e0b4)。
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 W1 的桩脚手架升级成一套真的 agent 核心——真 ReAct 主循环 + 工具框架 + 文件夹工作区边界 + `<env>` 环境注入,照 cc-haha 重写(reimplement,不搬源码)。

**Architecture:** 主循环写成依赖注入一个小 `Model` 接口(真模型出口留 W6),自动化测试用脚本化 fake model 喂确定性 tool_call 序列驱动。工具框架 = `Tool` 定义(名/描述/JSON schema/执行函数)+ `ToolRegistry`。工作区 = 选一个文件夹当根,读/写/列/跑命令都在边界内解析路径、越界抛错,写文件前走备份钩子。`<env>` 块(工作区/平台/shell/OS + git 快照)注入系统提示。

**Tech Stack:** TypeScript · Bun(`bun test`)· 仅 `node:` 内置模块(path/fs/child_process/os/crypto/util),W2 不引任何新 npm 依赖。

## Global Constraints

> 每个 Task 的要求都隐含包含本节。逐条来自主文档 §1 铁律 + `ts/CLAUDE.md`,值照抄。

- **照 cc-haha 重写、不搬码**:只可照它的做法用我们自己的 TS 重写,绝不把 cc-haha 源码文件原样拷进 `ts/`。
- **Bun ≥ 1.3.13**;后端测试一律 **`bun test`**(`import { test, expect } from 'bun:test'`),不用 vitest。
- **可用 `node:` API**(`node:path`/`node:fs`/`node:child_process`/`node:os` 等):sidecar/plumbing 要 Node+Bun 双运行时,别改成 `Bun.file`/`Bun.$` 专有 API。
- **W2 不引新依赖**:不加 zod/ajv 等;工具入参靠 `execute` 自校验并抛错,由主循环把错误回灌。
- **消息形态 = OpenAI 兼容**(role: system/user/assistant/tool):我们的模型出口是 OpenAI 兼容(MiMo/豆包/网关),现有 `loop.py` 即 `role:tool` 回灌。这是相对 cc-haha(Anthropic content-block)的有据偏离。
- **产品红线不丢**:改文件前自动备份(W2 落 `write_file`)· 危险命令直接拒(W2 落 `run_command` 最小种子)· `<env>`/系统提示**不出现底层模型名**(白标;模型身份是 W6)· 审批闸/权限三档**不在本窗**(W4)。
- **导入不带扩展名**(跟 W1 现有 `ts/src` 代码一致,如 `import type { AgentEvent } from '../types/events'`);类型导入用 `import type`(`verbatimModuleSyntax`)。
- **注释从简、结构/命名照 cc-haha**;`tsconfig` 开了 `strict` + `noUncheckedIndexedAccess`,数组/Map 取值按 `T | undefined` 处理。
- **明确不在本窗**:OS 真沙箱(W3)· 审批闸/权限三档(W4)· plan/todo/reminder/压缩/完整轨迹(W4)· 真模型出口/网关(W6)。别顺手做。

## File Structure

**新建:**
- `ts/src/types/message.ts` — `Message`(OpenAI 兼容 4 角色)、`ToolCall`。纯类型。
- `ts/src/types/model.ts` — `Model` 接口、`ModelStepInput`、`AssistantStep`。纯类型(主循环靠它做依赖注入)。
- `ts/src/tools/Tool.ts` — `Tool`、`ToolContext`、`ToolSpec`、`JSONSchema`。工具框架的形状。
- `ts/src/tools/registry.ts` — `ToolRegistry`(注册/查找/产出模型可见的 specs)。
- `ts/src/workspace/pathBoundary.ts` — `resolveInWorkspace()`、`WorkspaceBoundaryError`。纯路径边界逻辑。
- `ts/src/workspace/workspace.ts` — `Workspace`(根 + `resolve()` + 备份钩子 `backup()`)、`defaultBackupHook()`。
- `ts/src/tools/fileReadTool.ts` / `fileWriteTool.ts` / `listDirTool.ts` — 三个核心文件工具。
- `ts/src/tools/dangerousCommand.ts` — 危险命令最小分类器种子(红线,完整版 W4)。
- `ts/src/tools/runCommandTool.ts` — 命令工具(workspace 为 cwd)。
- `ts/src/tools/generalTools.ts` — `buildGeneralRegistry()` 把 4 个工具装成一个 `ToolRegistry`(对应 Python `registry.py` 的 general 层)。
- `ts/src/harness/env.ts` — `computeEnvInfo()`(`<env>` 块)、`getIsGit()`、`getGitStatus()`。
- `ts/src/harness/systemPrompt.ts` — `buildSystemPrompt()`(基座身份 + `<env>` + git 快照)。
- `ts/src/harness/fakeModel.ts` — `scriptedModel()` 脚本化 fake(测试 + 服务器 demo 共用;记录收到的 messages 供断言 `<env>` 已注入)。
- `ts/src/harness/loop.ts` — `runAgentLoop()` 真主循环 + 内部 `executeTool()`(永不抛)。
- 各文件配 `*.test.ts`。

**修改:**
- `ts/src/server/index.ts` — `/agent/hello` 改跑真 `runAgentLoop`(通用工具 + workspace=cwd + 脚本化 demo model),`/health` 不动。
- `ts/src/server/index.test.ts` — 断言 SSE 走真循环。

**删除(W1 桩,被真实现替代):**
- `ts/src/harness/helloLoop.ts` + `helloLoop.test.ts`
- `ts/src/tools/helloTool.ts` + `helloTool.test.ts`

---

### Task 1: 框架类型 + Tool + ToolRegistry

**Files:**
- Create: `ts/src/types/message.ts`
- Create: `ts/src/types/model.ts`
- Create: `ts/src/tools/Tool.ts`
- Create: `ts/src/tools/registry.ts`
- Test: `ts/src/tools/registry.test.ts`

**Interfaces:**
- Produces:
  - `Message`(`ts/src/types/message.ts`):`{ role:'system'; content:string } | { role:'user'; content:string } | { role:'assistant'; content:string; toolCalls?: ToolCall[] } | { role:'tool'; toolCallId:string; name:string; content:string }`
  - `ToolCall`:`{ id: string; name: string; input: unknown }`
  - `Model`(`ts/src/types/model.ts`):`{ step(input: ModelStepInput): Promise<AssistantStep> }`
  - `ModelStepInput`:`{ messages: Message[]; tools: ToolSpec[] }`
  - `AssistantStep`:`{ kind:'tool_calls'; text?: string; calls: ToolCall[] } | { kind:'final'; text: string }`
  - `JSONSchema`(`ts/src/tools/Tool.ts`):`{ type:'object'; properties?: Record<string, unknown>; required?: string[]; [k:string]: unknown }`
  - `ToolContext`:`{ workspace: Workspace; signal?: AbortSignal }`
  - `ToolSpec`:`{ name: string; description: string; parameters: JSONSchema }`
  - `Tool<Input = unknown>`:`{ name: string; description: string; inputSchema: JSONSchema; isReadOnly: boolean; execute(input: Input, ctx: ToolContext): Promise<string> }`
  - `ToolRegistry`(`ts/src/tools/registry.ts`):`register(tool)`、`get(name): Tool | undefined`、`list(): Tool[]`、`specs(): ToolSpec[]`

- [ ] **Step 1: 写失败测试** — `ts/src/tools/registry.test.ts`

```ts
import { test, expect } from 'bun:test'
import { ToolRegistry } from './registry'
import type { Tool } from './Tool'

const echoTool: Tool<{ msg: string }> = {
  name: 'echo',
  description: 'echoes msg',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  isReadOnly: true,
  async execute(input) {
    return String(input.msg)
  },
}

test('registry registers, looks up, and lists tools', () => {
  const reg = new ToolRegistry([echoTool])
  expect(reg.get('echo')).toBe(echoTool)
  expect(reg.get('nope')).toBeUndefined()
  expect(reg.list().map(t => t.name)).toEqual(['echo'])
})

test('registry produces model-facing specs (name/description/parameters)', () => {
  const reg = new ToolRegistry([echoTool])
  expect(reg.specs()).toEqual([
    { name: 'echo', description: 'echoes msg', parameters: echoTool.inputSchema },
  ])
})

test('registry rejects duplicate tool names', () => {
  const reg = new ToolRegistry([echoTool])
  expect(() => reg.register(echoTool)).toThrow(/duplicate/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/tools/registry.test.ts`
Expected: FAIL(`Cannot find module './registry'`)

- [ ] **Step 3: 写类型文件**

`ts/src/types/message.ts`:
```ts
/** OpenAI 兼容消息(我们的模型出口是 OpenAI 兼容;对标 loop.py 的 role:tool 回灌)。 */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }
```

`ts/src/types/model.ts`:
```ts
import type { Message, ToolCall } from './message'
import type { ToolSpec } from '../tools/Tool'

export interface ModelStepInput {
  messages: Message[]
  tools: ToolSpec[]
}

/** 模型一步的产出:要么请求若干工具,要么收敛到最终答复。真模型(W6)把 LLM 响应解析成这个;fake 直接返回。 */
export type AssistantStep =
  | { kind: 'tool_calls'; text?: string; calls: ToolCall[] }
  | { kind: 'final'; text: string }

/** 主循环依赖注入的小接口——真模型出口留 W6,测试用脚本化 fake 驱动。 */
export interface Model {
  step(input: ModelStepInput): Promise<AssistantStep>
}
```

- [ ] **Step 4: 写 Tool + registry**

`ts/src/tools/Tool.ts`:
```ts
import type { Workspace } from '../workspace/workspace'

export type JSONSchema = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [k: string]: unknown
}

export interface ToolContext {
  workspace: Workspace
  signal?: AbortSignal
}

/** 模型可见的工具描述(function-calling 线上格式)。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
}

/** W2 最小 Tool——name/description/JSON schema/执行函数 + isReadOnly(播种 W4 权限心智)。 */
export interface Tool<Input = unknown> {
  name: string
  description: string
  inputSchema: JSONSchema
  isReadOnly: boolean
  execute(input: Input, ctx: ToolContext): Promise<string>
}
```

`ts/src/tools/registry.ts`:
```ts
import type { Tool, ToolSpec } from './Tool'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Tool[] {
    return [...this.tools.values()]
  }

  specs(): ToolSpec[] {
    return this.list().map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }))
  }
}
```

> 注:`Tool.ts` 引 `Workspace` 类型、`workspace.ts` 尚未建(Task 3)。本 Task 只跑 `registry.test.ts`(不 import workspace 值,仅类型),`bun test` 能过;`tsc --noEmit` 会因缺 `../workspace/workspace` 报错——这是预期,Task 3 建完即消。本 Task 步骤 6 只提交、不跑全量 typecheck(留到 Task 3 后)。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ts && bun test src/tools/registry.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 6: 提交**

```bash
cd ts && git add src/types/message.ts src/types/model.ts src/tools/Tool.ts src/tools/registry.ts src/tools/registry.test.ts
git commit -m "feat(ts): W2 工具框架类型 + ToolRegistry"
```

---

### Task 2: 路径边界（工作区越界抛错）

**Files:**
- Create: `ts/src/workspace/pathBoundary.ts`
- Test: `ts/src/workspace/pathBoundary.test.ts`

**Interfaces:**
- Produces:
  - `WorkspaceBoundaryError extends Error`:`{ requested: string; root: string }`
  - `resolveInWorkspace(root: string, requested: string): string` — 相对路径相对 `root` 解析、绝对路径原样;`resolve` 折叠 `..` 后若逃出 `root` 抛 `WorkspaceBoundaryError`;返回规范化后的绝对路径。

- [ ] **Step 1: 写失败测试** — `ts/src/workspace/pathBoundary.test.ts`

```ts
import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
import { resolveInWorkspace, WorkspaceBoundaryError } from './pathBoundary'

const ROOT = resolve('/tmp/ws-root')

test('resolves a relative path against the workspace root', () => {
  expect(resolveInWorkspace(ROOT, 'a/b.txt')).toBe(resolve(ROOT, 'a/b.txt'))
})

test('allows an absolute path that is inside the workspace', () => {
  expect(resolveInWorkspace(ROOT, resolve(ROOT, 'x.txt'))).toBe(resolve(ROOT, 'x.txt'))
})

test('allows internal ".." that stays inside the workspace', () => {
  expect(resolveInWorkspace(ROOT, 'a/../b.txt')).toBe(resolve(ROOT, 'b.txt'))
})

test('allows the root itself', () => {
  expect(resolveInWorkspace(ROOT, '.')).toBe(ROOT)
})

test('rejects ".." that escapes the workspace', () => {
  expect(() => resolveInWorkspace(ROOT, '../outside.txt')).toThrow(WorkspaceBoundaryError)
})

test('rejects an absolute path outside the workspace', () => {
  expect(() => resolveInWorkspace(ROOT, '/etc/passwd')).toThrow(WorkspaceBoundaryError)
})

test('rejects a sibling directory sharing a name prefix', () => {
  // root=/tmp/ws-root, target=/tmp/ws-root-evil must NOT be treated as inside
  expect(() => resolveInWorkspace(ROOT, resolve('/tmp/ws-root-evil/x'))).toThrow(WorkspaceBoundaryError)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/workspace/pathBoundary.test.ts`
Expected: FAIL(`Cannot find module './pathBoundary'`)

- [ ] **Step 3: 写实现**

`ts/src/workspace/pathBoundary.ts`:
```ts
import { isAbsolute, relative, resolve } from 'node:path'

export class WorkspaceBoundaryError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`越界：路径 ${requested} 在工作区 ${root} 之外，拒绝`)
    this.name = 'WorkspaceBoundaryError'
  }
}

/**
 * 把 requested 解析到工作区内的绝对路径。相对路径相对 root 解析,绝对路径原样;
 * resolve 折叠 `..` 后用 relative 判是否逃出 root——逃出(`..` 开头或跨盘绝对)即抛。
 * 不盲目拒 `..`:`a/../b` 停在区内、合法。硬 OS 沙箱 + TOCTOU(UNC/~user/$展开)是 W3。
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const absRoot = resolve(root)
  const target = isAbsolute(requested) ? resolve(requested) : resolve(absRoot, requested)
  const rel = relative(absRoot, target)
  if (rel === '') return target
  if (rel === '..' || rel.startsWith(`..${'/'}`) || rel.startsWith(`..${'\\'}`) || isAbsolute(rel)) {
    throw new WorkspaceBoundaryError(requested, absRoot)
  }
  return target
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/workspace/pathBoundary.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
cd ts && git add src/workspace/pathBoundary.ts src/workspace/pathBoundary.test.ts
git commit -m "feat(ts): W2 工作区路径边界(越界抛错·内部..合法)"
```

---

### Task 3: Workspace + 备份钩子

**Files:**
- Create: `ts/src/workspace/workspace.ts`
- Test: `ts/src/workspace/workspace.test.ts`

**Interfaces:**
- Consumes: `resolveInWorkspace`(Task 2)
- Produces:
  - `BackupHook`:`(absPath: string) => Promise<void>`
  - `Workspace`:`new Workspace(root: string, opts?: { backupHook?: BackupHook })`;字段 `root: string`;方法 `resolve(requested: string): string`(委托 `resolveInWorkspace`)、`backup(absPath: string): Promise<void>`。
  - `defaultBackupHook(root: string): BackupHook` — 若目标是已存在文件,改前 copy 到 `<root>/.backups/<basename>.<pathHash>.bak`;新文件/异常不阻塞写。

- [ ] **Step 1: 写失败测试** — `ts/src/workspace/workspace.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Workspace } from './workspace'
import { WorkspaceBoundaryError } from './pathBoundary'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('resolve() delegates to the workspace boundary', () => {
  const ws = new Workspace(root)
  expect(ws.resolve('a.txt')).toBe(resolve(root, 'a.txt'))
  expect(() => ws.resolve('../evil')).toThrow(WorkspaceBoundaryError)
})

test('backup() copies an existing file into .backups before overwrite', async () => {
  const ws = new Workspace(root)
  const target = join(root, 'report.txt')
  writeFileSync(target, 'OLD')
  await ws.backup(target)
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1)
  expect(readFileSync(join(root, '.backups', backups[0]!), 'utf8')).toBe('OLD')
})

test('backup() is a no-op for a not-yet-existing file', async () => {
  const ws = new Workspace(root)
  await ws.backup(join(root, 'new.txt'))
  expect(existsSync(join(root, '.backups'))).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/workspace/workspace.test.ts`
Expected: FAIL(`Cannot find module './workspace'`)

- [ ] **Step 3: 写实现**

`ts/src/workspace/workspace.ts`:
```ts
import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { resolveInWorkspace } from './pathBoundary'

export type BackupHook = (absPath: string) => Promise<void>

/** 选一个文件夹当工作区:读/写/列/跑命令都经 resolve() 在边界内解析;写前经 backup() 备份。 */
export class Workspace {
  readonly root: string
  private readonly backupHook: BackupHook

  constructor(root: string, opts: { backupHook?: BackupHook } = {}) {
    this.root = resolve(root)
    this.backupHook = opts.backupHook ?? defaultBackupHook(this.root)
  }

  resolve(requested: string): string {
    return resolveInWorkspace(this.root, requested)
  }

  async backup(absPath: string): Promise<void> {
    await this.backupHook(absPath)
  }
}

function shortHash(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 8)
}

/** 改前把已存在文件 copy 进 <root>/.backups(红线:改文件前可回滚)。完整 shadow-git 版留后面。 */
export function defaultBackupHook(root: string): BackupHook {
  return async absPath => {
    try {
      const s = await stat(absPath).catch(() => null)
      if (!s || !s.isFile()) return
      const dir = join(root, '.backups')
      await mkdir(dir, { recursive: true })
      await copyFile(absPath, join(dir, `${basename(absPath)}.${shortHash(absPath)}.bak`))
    } catch {
      // 备份尽力而为,绝不因备份失败阻塞写
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/workspace/workspace.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: 全量 typecheck(此时 Task 1 的 Workspace 引用已可解析)**

Run: `cd ts && bun run typecheck`
Expected: 0 错(W1 桩仍在,不影响)

- [ ] **Step 6: 提交**

```bash
cd ts && git add src/workspace/workspace.ts src/workspace/workspace.test.ts
git commit -m "feat(ts): W2 Workspace + 改前备份钩子"
```

---

### Task 4: 核心文件工具（读/写/列）

**Files:**
- Create: `ts/src/tools/fileReadTool.ts`
- Create: `ts/src/tools/fileWriteTool.ts`
- Create: `ts/src/tools/listDirTool.ts`
- Test: `ts/src/tools/fileTools.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`(Task 1)、`Workspace`(Task 3)
- Produces:
  - `fileReadTool: Tool<{ path: string }>`(name `read_file`,isReadOnly true)
  - `fileWriteTool: Tool<{ path: string; content: string }>`(name `write_file`,isReadOnly false,写前 `ctx.workspace.backup`)
  - `listDirTool: Tool<{ path?: string }>`(name `list_dir`,isReadOnly true,默认列 root)

- [ ] **Step 1: 写失败测试** — `ts/src/tools/fileTools.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'

let root: string
let ctx: ToolContext
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('read_file reads a file inside the workspace', async () => {
  writeFileSync(join(root, 'a.txt'), 'hello')
  expect(await fileReadTool.execute({ path: 'a.txt' }, ctx)).toBe('hello')
})

test('write_file creates a file and backs up an existing one on overwrite', async () => {
  await fileWriteTool.execute({ path: 'note.txt', content: 'v1' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v1')
  await fileWriteTool.execute({ path: 'note.txt', content: 'v2' }, ctx)
  expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('v2')
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1) // 覆盖前备份了 v1
})

test('list_dir lists the workspace root by default', async () => {
  writeFileSync(join(root, 'a.txt'), '')
  writeFileSync(join(root, 'b.txt'), '')
  const out = await listDirTool.execute({}, ctx)
  expect(out.split('\n')).toEqual(['a.txt', 'b.txt'])
})

test('file tools reject a path that escapes the workspace', async () => {
  await expect(fileReadTool.execute({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(/越界/)
  await expect(fileWriteTool.execute({ path: '../evil.txt', content: 'x' }, ctx)).rejects.toThrow(/越界/)
})

test('write_file throws on invalid input (missing content)', async () => {
  // @ts-expect-error 故意传非法入参,验证工具自校验抛错(主循环会把它回灌)
  await expect(fileWriteTool.execute({ path: 'x.txt' }, ctx)).rejects.toThrow()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/tools/fileTools.test.ts`
Expected: FAIL(`Cannot find module './fileReadTool'`)

- [ ] **Step 3: 写三个工具**

`ts/src/tools/fileReadTool.ts`:
```ts
import { readFile } from 'node:fs/promises'
import type { Tool } from './Tool'

export const fileReadTool: Tool<{ path: string }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file inside the workspace. Input: { path }.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  isReadOnly: true,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string') throw new Error('read_file 需要 string 参数 path')
    return await readFile(ctx.workspace.resolve(input.path), 'utf8')
  },
}
```

`ts/src/tools/fileWriteTool.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from './Tool'

export const fileWriteTool: Tool<{ path: string; content: string }> = {
  name: 'write_file',
  description:
    'Create or overwrite a UTF-8 text file inside the workspace (an existing file is backed up first). Input: { path, content }.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!input || typeof input.path !== 'string' || typeof input.content !== 'string') {
      throw new Error('write_file 需要 string 参数 path 和 content')
    }
    const abs = ctx.workspace.resolve(input.path)
    await ctx.workspace.backup(abs) // 红线:改文件前自动备份
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    return `已写入 ${input.path}（${input.content.length} 字符）`
  },
}
```

`ts/src/tools/listDirTool.ts`:
```ts
import { readdir } from 'node:fs/promises'
import type { Tool } from './Tool'

export const listDirTool: Tool<{ path?: string }> = {
  name: 'list_dir',
  description: 'List entries of a directory inside the workspace. Input: { path? } (default = workspace root).',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  isReadOnly: true,
  async execute(input, ctx) {
    const abs = ctx.workspace.resolve(input?.path ?? '.')
    const entries = await readdir(abs, { withFileTypes: true })
    return entries
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n')
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/tools/fileTools.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
cd ts && git add src/tools/fileReadTool.ts src/tools/fileWriteTool.ts src/tools/listDirTool.ts src/tools/fileTools.test.ts
git commit -m "feat(ts): W2 核心文件工具 read/write/list(边界内解析+改前备份)"
```

---

### Task 5: run_command 工具（+ 危险命令最小种子）

**Files:**
- Create: `ts/src/tools/dangerousCommand.ts`
- Create: `ts/src/tools/runCommandTool.ts`
- Test: `ts/src/tools/runCommandTool.test.ts`

**Interfaces:**
- Consumes: `Tool`/`ToolContext`(Task 1)、`Workspace`(Task 3)
- Produces:
  - `isDangerousCommand(command: string): boolean` — 命中删根/提权/格式化/fork 炸弹等即 true(最小种子;完整分类器 W4)
  - `runCommandTool: Tool<{ command: string }>`(name `run_command`,isReadOnly false,cwd=workspace.root,30s 超时,危险命令直接拒)

- [ ] **Step 1: 写失败测试** — `ts/src/tools/runCommandTool.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { runCommandTool } from './runCommandTool'
import { isDangerousCommand } from './dangerousCommand'

let root: string
let ctx: ToolContext
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('run_command runs a command and captures stdout', async () => {
  const out = await runCommandTool.execute({ command: 'echo hello-w2' }, ctx)
  expect(out).toContain('hello-w2')
})

test('run_command runs with the workspace as cwd', async () => {
  const out = await runCommandTool.execute({ command: 'pwd' }, ctx)
  expect(out).toContain(root)
})

test('run_command reports a non-zero exit', async () => {
  const out = await runCommandTool.execute({ command: 'exit 3' }, ctx)
  expect(out).toContain('3')
})

test('isDangerousCommand flags catastrophic commands', () => {
  expect(isDangerousCommand('rm -rf /')).toBe(true)
  expect(isDangerousCommand('rm -rf ~')).toBe(true)
  expect(isDangerousCommand('sudo reboot')).toBe(true)
  expect(isDangerousCommand('ls -la')).toBe(false)
})

test('run_command refuses a dangerous command', async () => {
  await expect(runCommandTool.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow(/危险命令/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/tools/runCommandTool.test.ts`
Expected: FAIL(`Cannot find module './runCommandTool'`)

- [ ] **Step 3: 写实现**

`ts/src/tools/dangerousCommand.ts`:
```ts
/**
 * 危险命令最小种子(红线 4:删根/提权/格式化直接拒)。W2 只挡灾难级;
 * 完整分类器(可逆性/爆炸半径/审批档)是 W4。宁可漏杀(交 W4)不可错放这几条。
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/, // rm -rf / | ~ | $HOME
  /\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r?[a-z]*\s+(\/|~|\$HOME)(\s|$)/,
  /\bsudo\b/, // 提权
  /\bmkfs\b/, // 格式化
  /\bdd\s+.*\bof=\/dev\//, // 覆写块设备
  /:\(\)\s*\{.*\}\s*;/, // fork 炸弹 :(){ :|:& };:
  /\b(shutdown|reboot|halt|poweroff)\b/,
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(command))
}
```

`ts/src/tools/runCommandTool.ts`:
```ts
import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './Tool'
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
    return await runInWorkspace(input.command, ctx)
  },
}

function runInWorkspace(command: string, ctx: ToolContext): Promise<string> {
  const isWin = process.platform === 'win32'
  const child = isWin ? spawn('cmd', ['/c', command], { cwd: ctx.workspace.root })
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

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/tools/runCommandTool.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 5: 提交**

```bash
cd ts && git add src/tools/dangerousCommand.ts src/tools/runCommandTool.ts src/tools/runCommandTool.test.ts
git commit -m "feat(ts): W2 run_command 工具(workspace cwd + 危险命令拒绝种子)"
```

---

### Task 6: 通用工具注册表

**Files:**
- Create: `ts/src/tools/generalTools.ts`
- Test: `ts/src/tools/generalTools.test.ts`

**Interfaces:**
- Consumes: 四个工具(Task 4/5)、`ToolRegistry`(Task 1)
- Produces: `buildGeneralRegistry(): ToolRegistry` — 装入 read_file/write_file/list_dir/run_command(对应 Python `registry.py` 的 general 层;billiards 层是后续窗)。

- [ ] **Step 1: 写失败测试** — `ts/src/tools/generalTools.test.ts`

```ts
import { test, expect } from 'bun:test'
import { buildGeneralRegistry } from './generalTools'

test('general registry contains the four core tools', () => {
  const reg = buildGeneralRegistry()
  expect(reg.list().map(t => t.name).sort()).toEqual(['list_dir', 'read_file', 'run_command', 'write_file'])
})

test('general registry specs are model-facing (have parameters)', () => {
  const specs = buildGeneralRegistry().specs()
  for (const s of specs) expect(s.parameters.type).toBe('object')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/tools/generalTools.test.ts`
Expected: FAIL(`Cannot find module './generalTools'`)

- [ ] **Step 3: 写实现**

`ts/src/tools/generalTools.ts`:
```ts
import { ToolRegistry } from './registry'
import { fileReadTool } from './fileReadTool'
import { fileWriteTool } from './fileWriteTool'
import { listDirTool } from './listDirTool'
import { runCommandTool } from './runCommandTool'

/** 通用 Agent 默认工具集(对应 Python registry.py 的 general 层)。领域层(billiards)是后续窗。 */
export function buildGeneralRegistry(): ToolRegistry {
  return new ToolRegistry([fileReadTool, fileWriteTool, listDirTool, runCommandTool])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/tools/generalTools.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
cd ts && git add src/tools/generalTools.ts src/tools/generalTools.test.ts
git commit -m "feat(ts): W2 通用工具注册表(4 核心工具)"
```

---

### Task 7: `<env>` 环境块 + 系统提示装配

**Files:**
- Create: `ts/src/harness/env.ts`
- Create: `ts/src/harness/systemPrompt.ts`
- Test: `ts/src/harness/env.test.ts`
- Test: `ts/src/harness/systemPrompt.test.ts`

**Interfaces:**
- Consumes: `Workspace`(Task 3)
- Produces:
  - `computeEnvInfo(opts: { workspaceRoot: string; isGit: boolean }): string` — `<env>...</env>` 块(工作区/平台/shell/OS)。**不含模型名行**(白标)。
  - `getIsGit(cwd: string): Promise<boolean>`
  - `getGitStatus(cwd: string): Promise<string | null>` — 分支/状态/近 5 提交快照;非 git 或出错返回 null。
  - `buildSystemPrompt(workspace: Workspace): Promise<string>` — 基座身份 + `<env>` + git 快照拼装。

- [ ] **Step 1: 写失败测试** — `ts/src/harness/env.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeEnvInfo, getIsGit, getGitStatus } from './env'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('computeEnvInfo emits an <env> block with workspace/platform/OS', () => {
  const block = computeEnvInfo({ workspaceRoot: '/tmp/demo', isGit: true })
  expect(block).toContain('<env>')
  expect(block).toContain('</env>')
  expect(block).toContain('Working directory: /tmp/demo')
  expect(block).toContain('Is directory a git repo: Yes')
  expect(block).toContain(`Platform: ${process.platform}`)
})

test('computeEnvInfo never leaks a model name (白标)', () => {
  const block = computeEnvInfo({ workspaceRoot: '/tmp/demo', isGit: false })
  expect(block.toLowerCase()).not.toContain('claude')
  expect(block.toLowerCase()).not.toContain('gpt')
  expect(block.toLowerCase()).not.toContain('mimo')
})

test('getIsGit/getGitStatus reflect a real git repo', async () => {
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  writeFileSync(join(root, 'f.txt'), 'x')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
  expect(await getIsGit(root)).toBe(true)
  const status = await getGitStatus(root)
  expect(status).toContain('git status at the start of the conversation')
  expect(status).toContain('Current branch:')
  expect(status).toContain('init') // 近提交里有 init
})

test('getGitStatus returns null outside a git repo', async () => {
  expect(await getIsGit(root)).toBe(false)
  expect(await getGitStatus(root)).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/harness/env.test.ts`
Expected: FAIL(`Cannot find module './env'`)

- [ ] **Step 3: 写 env.ts**

`ts/src/harness/env.ts`:
```ts
import { execFile } from 'node:child_process'
import { release, type as osType } from 'node:os'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface EnvInfoOptions {
  workspaceRoot: string
  isGit: boolean
}

/** <env> 环境块(照 cc-haha computeEnvInfo)。刻意不含模型名/知识截止行——白标 + 模型身份是 W6。 */
export function computeEnvInfo(opts: EnvInfoOptions): string {
  const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : 'unknown')
  return [
    'Here is useful information about the environment you are running in:',
    '<env>',
    `Working directory: ${opts.workspaceRoot}`,
    `Is directory a git repo: ${opts.isGit ? 'Yes' : 'No'}`,
    `Platform: ${process.platform}`,
    `Shell: ${shell}`,
    `OS Version: ${osType()} ${release()}`,
    '</env>',
  ].join('\n')
}

export async function getIsGit(cwd: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    return true
  } catch {
    return false
  }
}

/** 对话开头的 git 快照(照 context.ts getGitStatus):分支 + status --short + 近 5 提交。 */
export async function getGitStatus(cwd: string): Promise<string | null> {
  if (!(await getIsGit(cwd))) return null
  try {
    const run = (args: string[]) =>
      execFileP('git', args, { cwd })
        .then(r => r.stdout.trim())
        .catch(() => '')
    const [branch, status, log] = await Promise.all([
      run(['--no-optional-locks', 'branch', '--show-current']),
      run(['--no-optional-locks', 'status', '--short']),
      run(['--no-optional-locks', 'log', '--oneline', '-n', '5']),
    ])
    return [
      'This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.',
      `Current branch: ${branch}`,
      `Status:\n${status || '(clean)'}`,
      `Recent commits:\n${log}`,
    ].join('\n\n')
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ts && bun test src/harness/env.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: 写失败测试** — `ts/src/harness/systemPrompt.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildSystemPrompt } from './systemPrompt'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('buildSystemPrompt injects the <env> block with the workspace root', async () => {
  const prompt = await buildSystemPrompt(new Workspace(root))
  expect(prompt).toContain('<env>')
  expect(prompt).toContain(`Working directory: ${root}`)
})

test('buildSystemPrompt never leaks a model name (白标)', async () => {
  const prompt = (await buildSystemPrompt(new Workspace(root))).toLowerCase()
  expect(prompt).not.toContain('claude')
  expect(prompt).not.toContain('gpt')
})
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd ts && bun test src/harness/systemPrompt.test.ts`
Expected: FAIL(`Cannot find module './systemPrompt'`)

- [ ] **Step 7: 写 systemPrompt.ts**

`ts/src/harness/systemPrompt.ts`:
```ts
import type { Workspace } from '../workspace/workspace'
import { computeEnvInfo, getGitStatus, getIsGit } from './env'

// W2 占位基座身份。白标 anti-reveal + 完整人设(通用/台球)是 W4/W10;这里只保证不暴露模型。
const BASE_IDENTITY = '你是一个装在用户电脑上的本机 AI 助手,能读写文件、跑命令,实打实把活干完。'

/** 系统提示装配:基座身份 + <env> 环境块 + git 快照(有则附)。 */
export async function buildSystemPrompt(workspace: Workspace): Promise<string> {
  const isGit = await getIsGit(workspace.root)
  const env = computeEnvInfo({ workspaceRoot: workspace.root, isGit })
  const gitStatus = await getGitStatus(workspace.root)
  return [BASE_IDENTITY, env, ...(gitStatus ? [gitStatus] : [])].join('\n\n')
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd ts && bun test src/harness/systemPrompt.test.ts`
Expected: PASS(2 tests)

- [ ] **Step 9: 提交**

```bash
cd ts && git add src/harness/env.ts src/harness/env.test.ts src/harness/systemPrompt.ts src/harness/systemPrompt.test.ts
git commit -m "feat(ts): W2 <env> 环境块 + git 快照 + 系统提示装配(白标)"
```

---

### Task 8: 真主循环 + 脚本化 fake model（核心交付）

**Files:**
- Create: `ts/src/harness/fakeModel.ts`
- Create: `ts/src/harness/loop.ts`
- Test: `ts/src/harness/loop.test.ts`

**Interfaces:**
- Consumes: `Model`/`AssistantStep`(Task 1)、`Message`(Task 1)、`ToolRegistry`(Task 1)、`Workspace`(Task 3)、`AgentEvent`(W1 `types/events`)
- Produces:
  - `scriptedModel(steps: AssistantStep[]): Model & { received: ModelStepInput[] }` — 按序返回步骤,记录每次收到的 `{ messages, tools }`(供断言 `<env>` 已注入)。
  - `RunAgentLoopOptions`:`{ model: Model; registry: ToolRegistry; workspace: Workspace; systemPrompt: string; userMessage: string; maxTurns?: number; signal?: AbortSignal }`
  - `runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent>` — think→有 tool_calls 逐个执行→结果作 tool 消息回灌→再 think→final;工具报错回灌不崩;max_turns 兜底强制收敛。

- [ ] **Step 1: 写失败测试** — `ts/src/harness/loop.test.ts`

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildGeneralRegistry } from '../tools/generalTools'
import { buildSystemPrompt } from './systemPrompt'
import { scriptedModel } from './fakeModel'
import { runAgentLoop } from './loop'
import type { AgentEvent } from '../types/events'
import type { AssistantStep } from '../types/model'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('runs a multi-step tool task: think -> tool -> feed back -> think -> final', async () => {
  writeFileSync(join(root, 'src.txt'), 'payload')
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', text: '先读源文件', calls: [{ id: '1', name: 'read_file', input: { path: 'src.txt' } }] },
    { kind: 'tool_calls', text: '再写出去', calls: [{ id: '2', name: 'write_file', input: { path: 'out.txt', content: 'payload!' } }] },
    { kind: 'final', text: '完成:已把 src.txt 复制加工到 out.txt' },
  ]
  const model = scriptedModel(steps)
  const events = await collect(
    runAgentLoop({
      model,
      registry: buildGeneralRegistry(),
      workspace: new Workspace(root),
      systemPrompt: 'SYS',
      userMessage: '把 src.txt 加工写进 out.txt',
    }),
  )
  expect(events.map(e => e.type)).toEqual([
    'thinking', 'tool_call', 'tool_result', 'thinking', 'tool_call', 'tool_result', 'final',
  ])
  expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('payload!')
  // 工具结果真的回灌进了 messages(第 2 次 model.step 应看到 role:tool 消息)
  const secondCallMessages = model.received[1]!.messages
  expect(secondCallMessages.some(m => m.role === 'tool' && m.content === 'payload')).toBe(true)
})

test('a tool error is fed back as text, the loop keeps going (does not crash)', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'read_file', input: { path: 'missing.txt' } }] },
    { kind: 'final', text: '文件不在,我改用别的办法' },
  ]
  const model = scriptedModel(steps)
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('错误')
  expect(events.at(-1)).toEqual({ type: 'final', text: '文件不在,我改用别的办法' })
  // 模型在下一步确实收到了错误文本回灌
  const fedBack = model.received[1]!.messages.some(m => m.role === 'tool' && m.content.includes('错误'))
  expect(fedBack).toBe(true)
})

test('an unknown tool is fed back as an error, not a crash', async () => {
  const steps: AssistantStep[] = [
    { kind: 'tool_calls', calls: [{ id: '1', name: 'no_such_tool', input: {} }] },
    { kind: 'final', text: 'ok' },
  ]
  const events = await collect(
    runAgentLoop({
      model: scriptedModel(steps), registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x',
    }),
  )
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('未知工具')
})

test('the <env> block reaches the model in the system message', async () => {
  const model = scriptedModel([{ kind: 'final', text: 'done' }])
  const systemPrompt = await buildSystemPrompt(new Workspace(root))
  await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt, userMessage: 'hi',
    }),
  )
  const firstMessages = model.received[0]!.messages
  const system = firstMessages.find(m => m.role === 'system')
  expect(system?.content).toContain('<env>')
  expect(system?.content).toContain(`Working directory: ${root}`)
})

test('max_turns fallback forces a final and terminates', async () => {
  // 模型每轮都要求工具、永不收敛;maxTurns=2 后强制一次无工具收敛
  const forever: AssistantStep = { kind: 'tool_calls', calls: [{ id: 'x', name: 'list_dir', input: {} }] }
  const model = scriptedModel([forever, forever, { kind: 'final', text: '被迫收尾' }])
  const events = await collect(
    runAgentLoop({
      model, registry: buildGeneralRegistry(), workspace: new Workspace(root),
      systemPrompt: 'SYS', userMessage: 'x', maxTurns: 2,
    }),
  )
  expect(events.at(-1)?.type).toBe('final')
  // 强制收敛那一步是"无工具"的
  expect(model.received.at(-1)!.tools).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ts && bun test src/harness/loop.test.ts`
Expected: FAIL(`Cannot find module './fakeModel'`)

- [ ] **Step 3: 写 fakeModel.ts**

`ts/src/harness/fakeModel.ts`:
```ts
import type { AssistantStep, Model, ModelStepInput } from '../types/model'

/** 脚本化 fake model:按序返回预设步骤,并记录每次收到的 {messages,tools}(供断言 <env> 已注入)。真模型 = W6。 */
export function scriptedModel(steps: AssistantStep[]): Model & { received: ModelStepInput[] } {
  let i = 0
  const received: ModelStepInput[] = []
  return {
    received,
    async step(input) {
      received.push(input)
      const s = steps[i++]
      if (!s) throw new Error(`scriptedModel: 步骤用尽(已用 ${i - 1} 步)`)
      return s
    },
  }
}
```

- [ ] **Step 4: 写 loop.ts**

`ts/src/harness/loop.ts`:
```ts
import type { AgentEvent } from '../types/events'
import type { Message, ToolCall } from '../types/message'
import type { Model } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'

export interface RunAgentLoopOptions {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  userMessage: string
  maxTurns?: number
  signal?: AbortSignal
}

/**
 * 真 ReAct 主循环(照 cc-haha query.ts / 现有 loop.py):
 * think → 有 tool_calls 就逐个执行 → 结果作 role:tool 回灌 → 再 think,直到收敛或 max_turns 兜底。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry, workspace } = opts
  const maxTurns = opts.maxTurns ?? 12
  const ctx: ToolContext = { workspace, signal: opts.signal }
  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userMessage },
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    const step = await model.step({ messages, tools: registry.specs() })
    if (step.kind === 'final') {
      messages.push({ role: 'assistant', content: step.text })
      yield { type: 'final', text: step.text }
      return
    }
    if (step.text) yield { type: 'thinking', text: step.text }
    messages.push({ role: 'assistant', content: step.text ?? '', toolCalls: step.calls })
    for (const call of step.calls) {
      yield { type: 'tool_call', tool: call.name, input: call.input }
      const output = await executeTool(registry, call, ctx)
      yield { type: 'tool_result', tool: call.name, output }
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output })
    }
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ messages, tools: [] })
  yield { type: 'final', text: forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)' }
}

/** 工具执行永不抛:不存在/入参非法/执行异常都转成错误文本回灌,让模型自救(照 loop.py)。 */
async function executeTool(registry: ToolRegistry, call: ToolCall, ctx: ToolContext): Promise<string> {
  const tool = registry.get(call.name)
  if (!tool) return `错误:未知工具 ${call.name}`
  try {
    return await tool.execute(call.input, ctx)
  } catch (err) {
    return `错误:工具 ${call.name} 执行失败:${err instanceof Error ? err.message : String(err)}`
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ts && bun test src/harness/loop.test.ts`
Expected: PASS(5 tests)

- [ ] **Step 6: 提交**

```bash
cd ts && git add src/harness/fakeModel.ts src/harness/loop.ts src/harness/loop.test.ts
git commit -m "feat(ts): W2 真主循环 + 脚本化 fake model(多步工具/报错回灌/env注入/max_turns兜底)"
```

---

### Task 9: 服务器 SSE 接真循环 + 退役 W1 桩

**Files:**
- Modify: `ts/src/server/index.ts`
- Modify: `ts/src/server/index.test.ts`(先 Read 再改)
- Delete: `ts/src/harness/helloLoop.ts`、`ts/src/harness/helloLoop.test.ts`
- Delete: `ts/src/tools/helloTool.ts`、`ts/src/tools/helloTool.test.ts`

> ⚠️ 修改前先 `Read` `ts/src/server/index.test.ts` 与 `ts/desktop/integration/sidecar.integration.test.ts`,确认它们对 `/agent/hello` 的断言,改测试对齐真循环(demo model 走 list_dir 后收敛)。integration 测试若断言旧桩输出,同步更新。

**Interfaces:**
- Consumes: `runAgentLoop`(Task 8)、`buildGeneralRegistry`(Task 6)、`buildSystemPrompt`(Task 7)、`scriptedModel`(Task 8)、`Workspace`(Task 3)
- Produces: `/agent/hello` SSE 走真 `runAgentLoop`——通用工具 + workspace=`process.cwd()` + 脚本化 demo model(真列一次工作区再收敛;真模型出口 = W6)。`/health` 不变。

- [ ] **Step 1: 改 server/index.ts**

`ts/src/server/index.ts`(整文件替换):
```ts
import { runAgentLoop } from '../harness/loop'
import { buildSystemPrompt } from '../harness/systemPrompt'
import { scriptedModel } from '../harness/fakeModel'
import { buildGeneralRegistry } from '../tools/generalTools'
import { Workspace } from '../workspace/workspace'
import type { AssistantStep } from '../types/model'
import type { AgentEvent } from '../types/events'

function sseLine(ev: AgentEvent | { type: 'done' }): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

/** W2 后端。/health + /agent/hello(真主循环 demo:真列一次工作区再收敛;真模型出口 = W6)。 */
export function startServer(opts: { host?: string; port?: number } = {}) {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 8850
  return Bun.serve({
    hostname: host,
    port,
    idleTimeout: 30,
    async fetch(req, server) {
      const url = new URL(req.url)

      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: 'ts-harness', ts: Date.now() })
      }

      if (url.pathname === '/agent/hello') {
        server.timeout(req, 0) // 关掉 Bun 空闲掐断,否则安静的 SSE 流会被杀
        const workspace = new Workspace(process.cwd())
        const systemPrompt = await buildSystemPrompt(workspace)
        // demo model:请求列一次工作区,拿到结果后收敛。真模型出口留 W6。
        const demoSteps: AssistantStep[] = [
          { kind: 'tool_calls', text: '看看工作区里有什么', calls: [{ id: '1', name: 'list_dir', input: {} }] },
          { kind: 'final', text: '这是当前工作区的内容(demo:真模型接入在 W6)。' },
        ]
        const body = (async function* () {
          for await (const ev of runAgentLoop({
            model: scriptedModel(demoSteps),
            registry: buildGeneralRegistry(),
            workspace,
            systemPrompt,
            userMessage: '列一下工作区',
          })) {
            yield sseLine(ev)
          }
          yield sseLine({ type: 'done' })
        })()
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        })
      }

      return new Response('Not found', { status: 404 })
    },
  })
}
```

- [ ] **Step 2: 改 server/index.test.ts 断言真循环**

先 `Read` 现有测试;把 `/agent/hello` 的断言改为:SSE 事件里出现 `tool_call`(list_dir)+ `tool_result` + `final` + `done`,`/health` 仍 200。示例断言块:
```ts
test('/agent/hello streams the real loop (tool_call -> tool_result -> final -> done)', async () => {
  const server = startServer({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${server.port}/agent/hello`)
  const text = await res.text()
  expect(text).toContain('event: tool_call')
  expect(text).toContain('list_dir')
  expect(text).toContain('event: tool_result')
  expect(text).toContain('event: final')
  expect(text).toContain('event: done')
  server.stop(true)
})
```
(`/health` 的既有断言保留。)

- [ ] **Step 3: 跑 server 测试确认通过**

Run: `cd ts && bun test src/server/index.test.ts`
Expected: PASS

- [ ] **Step 4: 删 W1 桩 + 跑全量**

```bash
cd ts && git rm src/harness/helloLoop.ts src/harness/helloLoop.test.ts src/tools/helloTool.ts src/tools/helloTool.test.ts
bun test
bun run typecheck
```
Expected: `bun test` 全绿(无 hello 残留引用)、`typecheck` 0 错。若 integration 测试引用旧桩,一并更新至真循环。

- [ ] **Step 5: 提交**

```bash
cd ts && git add -A
git commit -m "feat(ts): W2 服务器 SSE 接真主循环 + 退役 W1 桩(helloLoop/helloTool)"
```

---

### Task 10: 全量验收 + W2 findings

**Files:**
- Create: `ts/docs/W2-harness-core-findings.md`

- [ ] **Step 1: 逐条重跑验收门(别盲信"全绿")**

```bash
cd ts && bun test 2>&1 | tail -20      # 全绿
cd ts && bun run typecheck             # 0 错
```
逐条对照验收门,分别记录"改了啥 / 验了啥":
- 真主循环多步工具任务(think→tool→回灌→think→final):`loop.test.ts` 第 1 例 ✓
- 工具报错回灌不崩循环:`loop.test.ts` 第 2/3 例 ✓
- 工作区读/写/列/跑命令边界内解析、`..` 越界抛错:`pathBoundary.test.ts` + `fileTools.test.ts` + `runCommandTool.test.ts` ✓
- `<env>` 块出现在发给模型的 messages 里:`loop.test.ts` 第 4 例 ✓
- `bun test` 全绿 + `tsc --noEmit` 0 错 ✓

- [ ] **Step 2: 写 W2 findings**(照 `ts/docs/W1-native-plugin-findings.md` 的样)

内容至少含:
- **决策**:消息用 OpenAI 兼容(非 cc-haha 的 Anthropic block)——理由 = 模型出口 OpenAI 兼容 + 对齐 loop.py;`Model` 依赖注入接口 + 脚本化 fake(真模型 W6);`<env>` 用 `<env>...</env>` 形态且刻意不含模型名(白标);路径边界 = resolve 后判 relative(不盲拒内部 `..`);备份钩子做成真 copy 到 `.backups`(shadow-git 完整版后置)。
- **W2 明确没做(留后窗)**:OS 真沙箱/TOCTOU 补强(UNC/~user/$展开)→ W3;审批闸/权限三档/危险命令完整分类器 → W4;plan/todo/reminder/压缩/完整轨迹 → W4;真模型出口/网关 → W6。
- **坑/注意**:`noUncheckedIndexedAccess` 下数组取值需 `!`/守卫;`run_command` 用 `sh -c`(win `cmd /c`)+ 30s 超时;server demo 用脚本化 model(非真推理)。
- **给后窗的硬约束**:⚠️ **从 W5 业务翻译窗起,验收门加硬条件——先把对应 Python 测试翻成 TS 测试、再让 TS 实现跑绿**,确保 5.7 万行翻译不丢已修的 bug。W2/W3/W4 是 harness(照 cc-haha)、不受此条约束。

- [ ] **Step 3: 提交 findings**

```bash
cd ts && git add docs/W2-harness-core-findings.md
git commit -m "docs(ts): W2 findings — harness 核心决策与坑 + 给后窗的硬约束"
```

- [ ] **Step 4: 收尾** — 用 `superpowers:verification-before-completion` 过门;push / 合 main 等 owner 发话(默认只本地)。把本计划 banner 标 `📦历史 · 已落地` 并按文档规约挪 `docs/归档/`(可在收尾时做)。下一窗 = W3 双层沙箱。

---

## Self-Review

**Spec coverage(对照任务四块 + 验收门):**
- ① 真主循环(替掉桩)→ Task 8 ✓;think→tool→回灌→think→final + 报错回灌不崩 + max_turns 兜底,均有测试。
- ② 工具框架(名/描述/JSON schema/执行 + 注册表 + 执行 + 报错回灌)→ Task 1(框架)+ Task 4/5(工具)+ Task 6(注册表)+ Task 8(执行/报错回灌)✓。
- ③ 文件夹工作区(边界内解析、`..` 越界抛错、备份钩子位置)→ Task 2(边界)+ Task 3(Workspace+备份)+ Task 4/5(工具用边界)✓。
- ④ `<env>` 注入(工作区/平台/git 快照,出现在发给模型的 messages)→ Task 7(env+systemPrompt)+ Task 8 第 4 例(断言在 messages)✓。
- 验收门 5 条 → Task 10 逐条重跑 ✓。
- 明确不在本窗(OS 沙箱/审批/plan-todo-压缩/真模型)→ 均未建,findings 记明归属窗口 ✓。

**Placeholder scan:** 无 TBD/TODO;每个 code 步骤给全实现与测试代码;危险命令种子是"最小但真实"、非占位。

**Type consistency:** `Tool.execute(input, ctx): Promise<string>`、`AssistantStep`(tool_calls/final)、`ToolCall{id,name,input}`、`Message` 4 角色、`runAgentLoop` 签名、`scriptedModel().received` —— 各 Task 的 Interfaces 块与 code 一致;`resolveInWorkspace`/`Workspace.resolve`/`buildGeneralRegistry`/`computeEnvInfo`/`getGitStatus`/`buildSystemPrompt` 命名前后统一。
