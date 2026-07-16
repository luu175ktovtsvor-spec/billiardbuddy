#!/usr/bin/env bun
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ts from '../../ts/desktop/node_modules/typescript/lib/typescript.js'

const root = path.resolve(import.meta.dir, '../..')
const violations: string[] = []
const rendererRoot = path.join(root, 'ts/desktop/renderer-react/src')
const backendRoot = path.join(root, 'ts/src')

const retiredFrontendFiles = [
  'ts/desktop/renderer/index.html',
  'ts/desktop/renderer/app.js',
  'ts/src/server/embeddedFrontend.ts',
  'ts/desktop/renderer-react/src/lib/previewSeed.ts',
  'docs/design/mockups/agent-chat.html',
  'docs/design/mockups/agent-preview.html',
  'docs/design/mockups/agent-welcome.html',
]

for (const file of retiredFrontendFiles) {
  if (await Bun.file(path.join(root, file)).exists()) {
    violations.push(`${file}:1:1 已退役的前端或假数据入口不得恢复；桌面产品只保留 renderer-react`)
  }
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
  // The billiard renderer-react tree may not exist yet in the imported kernel-only
  // state; skip a missing root instead of crashing (its boundary rules simply have
  // no files to scan until that layer is rebuilt).
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
  const isRendererNetworkBoundary = rel.includes('/api/') || rel.endsWith('/lib/desktopRuntime.ts')
  const isRendererWsBoundary = rel.endsWith('/api/websocket.ts')
  const isDesktopHostBoundary = rel.endsWith('/lib/desktopHost.ts')
  const scansRoutes = rel.includes('/components/') || rel.includes('/pages/')

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const resolved = resolvedImport(file, specifier)
      if (kind === 'renderer') {
        if (specifier === 'electron' || specifier.startsWith('node:') || specifier.startsWith('bun:')) {
          report(file, node, `renderer 不得导入 ${specifier}，原生能力必须走 desktopHost`, source)
        }
        if (resolved?.startsWith(`${backendRoot}${path.sep}`)) {
          report(file, node, 'renderer 不得导入后端内部模块，只能依赖 ts/shared/contracts', source)
        }
      } else if (resolved?.startsWith(`${rendererRoot}${path.sep}`)) {
        report(file, node, '后端不得反向依赖 React renderer', source)
      }
    }

    if (kind === 'renderer' && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch' && !isRendererNetworkBoundary) {
      report(file, node, 'fetch 只能出现在 renderer api 或 desktopRuntime 边界', source)
    }
    if (kind === 'renderer' && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WebSocket' && !isRendererWsBoundary) {
      report(file, node, 'WebSocket 只能由 renderer api/websocket.ts 创建', source)
    }
    if (
      kind === 'renderer' &&
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'window' &&
      node.expression.name.text === 'desktopHost' &&
      !isDesktopHostBoundary
    ) {
      report(file, node, 'window.desktopHost 只能在 lib/desktopHost.ts 读取', source)
    }
    if (kind === 'renderer' && scansRoutes && ts.isStringLiteralLike(node) && /^\/(api|agent|sessions|model)(\/|$)/.test(node.text)) {
      report(file, node, '组件和页面不得拼 API 路径，路径应归属功能 api 模块', source)
    }
    if (
      rel !== 'ts/shared/contracts/agent-events.ts' &&
      ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name.text === 'AgentEvent')
    ) {
      report(file, node, 'AgentEvent 只能由 ts/shared/contracts 定义，其他位置应导入或重导出', source)
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
