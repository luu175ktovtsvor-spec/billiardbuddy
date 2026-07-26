import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'

export type PackagedRendererTarget = {
  type?: unknown
  title?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配 renderer 验收端口')
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

export async function waitForPackagedRenderer(
  port: number,
  child: ChildProcess | null,
  timeoutMs = 60_000,
): Promise<PackagedRendererTarget> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = new Error('DevTools 目标尚未就绪')
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`BilliardBuddy 在 renderer 就绪前退出: ${child.exitCode}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`)
      const targets = await response.json() as PackagedRendererTarget[]
      const target = targets.find(value => value.type === 'page'
        && value.title === 'BilliardBuddy'
        && typeof value.url === 'string'
        && value.url.includes('/dist/index.html'))
      if (target) return target
      lastError = new Error('未找到正式 BilliardBuddy renderer')
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`安装包 renderer 未在 ${timeoutMs / 1_000} 秒内就绪: ${String(lastError)}`)
}

export async function evaluateInPackagedRenderer<T>(
  target: PackagedRendererTarget,
  expression: string,
  timeoutMs = 30_000,
): Promise<T> {
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('renderer 缺少 DevTools 调试地址')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  return await new Promise<T>((resolveValue, rejectValue) => {
    let settled = false
    const finish = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      if (error) rejectValue(error)
      else resolveValue(value as T)
    }
    const timeout = setTimeout(() => finish(new Error('renderer 产品 API 验收超时')), timeoutMs)
    socket.addEventListener('error', () => finish(new Error('无法连接 renderer DevTools')))
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    })
    socket.addEventListener('message', event => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: unknown
          error?: { message?: unknown }
          result?: {
            exceptionDetails?: { text?: unknown }
            result?: { value?: T, description?: unknown }
          }
        }
        if (payload.id !== 1) return
        if (payload.error) throw new Error(`renderer DevTools 调用失败: ${String(payload.error.message)}`)
        if (payload.result?.exceptionDetails) {
          throw new Error(`renderer 产品 API 调用失败: ${String(
            payload.result.result?.description ?? payload.result.exceptionDetails.text,
          )}`)
        }
        finish(undefined, payload.result?.result?.value)
      } catch (error) {
        finish(error)
      }
    })
  })
}

export async function terminatePackagedApp(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolveExit, reject) => {
      child.once('exit', () => resolveExit())
      child.once('error', reject)
    })
  }
}
