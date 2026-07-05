/** 合并 sidecar 入口(起步只 server 模式;cli/adapters 是后续)。照 cc-haha claude-sidecar.ts 的
 *  positional-mode 形状,但只解析 server + --host/--port。真多模式合并在 W13。 */
import { startServer } from '../../src/server/index'

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = '127.0.0.1'
  let port = 8850
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = argv[++i] ?? host
    else if (argv[i] === '--port') port = Number(argv[++i] ?? port)
  }
  return { host, port }
}

const [mode, ...rest] = process.argv.slice(2)
if (mode !== 'server') {
  console.error(`backend-sidecar: expected mode "server", got "${mode ?? '(none)'}"`)
  process.exit(2)
}
const { host, port } = parseArgs(rest)
const server = startServer({ host, port })
console.log(`[backend-sidecar] listening on http://${host}:${server.port}`)
