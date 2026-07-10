/** 合并 sidecar 入口(起步只 server 模式;cli/adapters 是后续)。照 cc-haha claude-sidecar.ts 的
 *  positional-mode 形状,但只解析 server + --host/--port。真多模式合并在 W13。 */
import { join } from 'node:path'
import { startServer, resolveStateRoot } from '../../src/server/index'
import { applyEnvFiles } from '../../src/model/envLoader'
import { ensureDefaultWorkspace } from '../../src/harness/desktopEnvNames'
import { installSidecarCrashGuards } from '../../src/utils/processCrashGuard'

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
applyEnvFiles()
// P0 顶层崩溃兜底(审计 16-trace-errors.md #6.1,详见 processCrashGuard.ts 头注释):
// 这是真正跑 harness 循环的 Bun 进程,漏网异常不兜住会打崩整个进程、拖死所有并发会话。
// 放在 applyEnvFiles 之后,让 BILLIARDBUDDY_STATE_DIR 等 env 覆盖在算 stateRoot 时已生效;
// 放在 ensureDefaultWorkspace/startServer 之前,覆盖它们往后(启动收尾 + 正式跑起来之后)的全部路径。
installSidecarCrashGuards({ logDir: join(resolveStateRoot({ env: process.env }), 'logs') })
// 首启确保显式全局默认工作区存在(~/Documents/球房管家/):不选文件夹时模型的落点,mkdir -p 尽力而为不阻塞启动。
await ensureDefaultWorkspace()
const server = startServer({ host, port })
console.log(`[backend-sidecar] listening on http://${host}:${server.port}`)
