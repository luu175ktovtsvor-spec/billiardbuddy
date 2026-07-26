/**
 * BilliardBuddy 桌面端合并 sidecar 入口。
 *
 * server / agent-worker / browser-host 是 GUI 产品的三个内部运行职责，共享一份
 * bun runtime。这不是公开 CLI；第一个位置参数只由 Electron/Product Server 使用：
 *
 *   billiardbuddy-sidecar server --app-root <path> --host 127.0.0.1 --port 12345
 *   billiardbuddy-sidecar agent-worker --app-root <path>
 *
 * 任何模式都必须先做 process.env / process.argv 设置，再 await 进入相应的
 * 子模块树。原因：server 与 worker 顶层都会立即
 * 读 process.argv / process.env，必须在它们求值前 splice 掉 --app-root、mode
 * 这些 launcher-only 参数。
 */

import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

const rawArgs = process.argv.slice(2)
const invocation = resolveSidecarInvocation(rawArgs)
if (!invocation.mode) {
  console.error('billiardbuddy-sidecar: missing internal mode')
  process.exit(2)
}
const mode = invocation.mode
const restArgs = invocation.restArgs

if (mode === 'browser-host') {
  const { runBrowserNativeHost } = await import('./browser-native-host')
  runBrowserNativeHost({ argv: restArgs })
} else {
  const { appRoot, args } = parseLauncherArgs(restArgs, invocation.defaultAppRoot)

  process.env.BILLIARDBUDDY_APP_ROOT = appRoot
  process.env.BB_COMPILED_SIDECAR = '1'
  process.argv = [process.argv[0]!, process.argv[1]!, ...args]

  if (mode === 'server') {
    console.log(`[billiardbuddy-sidecar] starting server mode (${process.platform}/${process.arch})`)
    const { startServer } = await import('../../src/server/index.ts')
    startServer()
  } else if (mode === 'agent-worker') {
    await import('../../src/entrypoints/agent-worker.ts')
  } else {
    console.error(`billiardbuddy-sidecar: unknown internal mode "${mode}"`)
    process.exit(2)
  }
}
