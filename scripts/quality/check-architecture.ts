#!/usr/bin/env bun
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ts from '../../ts/desktop/node_modules/typescript/lib/typescript.js'

// Boundary checker for the imported billiardbuddy desktop product.
//
// Facts this checker is written against (verified in the current tree, not the
// retired BilliardBuddy renderer-react/ts/shared layout):
//   - The React renderer lives in ts/desktop/src (NOT ts/desktop/renderer-react/src).
//   - There is NO ts/shared/contracts. Cross-layer types are three hand-mirrored
//     seams: ws/events.ts <-> desktop/src/types/chat.ts (ServerMessage is the
//     "agent event" union), server/api/* <-> desktop/src/api/*, and
//     electron/ipc/channels.ts + desktop/src/lib/desktopHost/types.ts.
//   - Native OS capability reaches the renderer only through the window.desktopHost
//     preload bridge; Electron code is quarantined in ts/desktop/electron/*.
// The checker therefore enforces the real invariants and must stay green on a
// clean baseline; it does not require a shared contracts module and does not
// force a refactor toward one.

const root = path.resolve(import.meta.dir, '../..')
const violations: string[] = []
const rendererRoot = path.join(root, 'ts/desktop/src')
const backendRoot = path.join(root, 'ts/src')

// The only renderer files allowed to open a raw network/native capability.
// Every other renderer module must go through these boundary owners.
const RENDERER_FETCH_PREFIX = 'ts/desktop/src/api/' // REST boundary layer (client.ts is the core)
const RENDERER_FETCH_EXTRA = new Set([
  'ts/desktop/src/lib/desktopRuntime.ts', // startup /health + /api/status probing and H5 connect
  'ts/desktop/src/components/browser/BrowserSurface.tsx', // the in-app browser surface
])
const RENDERER_WS_OWNER = 'ts/desktop/src/api/websocket.ts'
// window.desktopHost is the preload bridge global; only the bridge layer reads it raw.
function ownsDesktopHostGlobal(rel: string): boolean {
  return rel.startsWith('ts/desktop/src/lib/desktopHost/') || rel === 'ts/desktop/src/lib/touchH5.ts'
}

function relative(file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

function report(file: string, node: ts.Node, message: string, source: ts.SourceFile): void {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source))
  violations.push(`${relative(file)}:${line + 1}:${character + 1} ${message}`)
}

function resolvedImport(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return path.resolve(path.dirname(file), specifier)
}

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  try {
    if (!(await stat(dir)).isDirectory()) return files
  } catch {
    return files
  }
  for (const pattern of ['**/*.ts', '**/*.tsx']) {
    const glob = new Bun.Glob(pattern)
    for await (const item of glob.scan({ cwd: dir, absolute: true, onlyFiles: true })) {
      if (!item.includes('.test.') && !item.includes('.spec.')) files.push(item)
    }
  }
  return [...new Set(files)]
}

async function checkSource(file: string, kind: 'renderer' | 'backend'): Promise<void> {
  const text = await readFile(file, 'utf8')
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind)
  const rel = relative(file)
  const rendererMayFetch = rel.startsWith(RENDERER_FETCH_PREFIX) || RENDERER_FETCH_EXTRA.has(rel)

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const resolved = resolvedImport(file, specifier)
      if (kind === 'renderer') {
        if (specifier === 'electron' || specifier.startsWith('node:') || specifier.startsWith('bun:')) {
          report(file, node, `renderer 不得导入 ${specifier}，原生能力必须走 window.desktopHost 预加载桥`, source)
        }
        if (resolved?.startsWith(`${backendRoot}${path.sep}`)) {
          report(file, node, 'renderer 不得导入后端内部模块，跨层类型走 desktop/src/api + desktop/src/types 手写镜像边界', source)
        }
      } else if (resolved?.startsWith(`${rendererRoot}${path.sep}`)) {
        report(file, node, '后端(ts/src)不得反向依赖桌面 renderer(ts/desktop/src)', source)
      }
    }

    if (kind === 'renderer' && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && !rendererMayFetch) {
      report(file, node, 'fetch 只能出现在 renderer api 层、lib/desktopRuntime.ts 或浏览器面板 BrowserSurface.tsx', source)
    }
    if (kind === 'renderer' && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WebSocket' && rel !== RENDERER_WS_OWNER) {
      report(file, node, 'WebSocket 只能由 renderer api/websocket.ts 创建', source)
    }
    if (
      kind === 'renderer' &&
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'window' &&
      node.expression.name.text === 'desktopHost' &&
      !ownsDesktopHostGlobal(rel)
    ) {
      report(file, node, 'window.desktopHost 原始桥只能在 lib/desktopHost/ 桥接层或 lib/touchH5.ts 读取', source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

for (const file of await sourceFiles(rendererRoot)) await checkSource(file, 'renderer')
for (const file of await sourceFiles(backendRoot)) await checkSource(file, 'backend')

const baseline = await Bun.file(path.join(import.meta.dir, 'architecture-baseline.json')).json() as Record<string, number>
for (const [file, maxLines] of Object.entries(baseline)) {
  const absolute = path.join(root, file)
  await stat(absolute)
  const lines = (await readFile(absolute, 'utf8')).split(/\r?\n/).length - 1
  if (lines > maxLines) {
    violations.push(`${file}:1:1 文件从治理基线 ${maxLines} 行增长到 ${lines} 行；先提取责任模块，不再扩大巨型文件`)
  }
}

if (violations.length > 0) {
  console.error(`架构边界检查失败（${violations.length} 项）:\n${violations.join('\n')}`)
  process.exit(1)
}

console.log('架构边界检查通过')
