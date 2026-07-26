import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ElectronServerRuntime } from './serverRuntime'
import type { SidecarChild } from './sidecarManager'

function child() {
  const value = new EventEmitter() as SidecarChild & { kill: ReturnType<typeof vi.fn>; exitCode: number | null }
  value.kill = vi.fn()
  value.exitCode = null
  return value
}
function deferredChild() {
  const value = child()
  value.kill.mockImplementation(() => undefined)
  return value
}

describe('ElectronServerRuntime access-token reconfiguration', () => {
  it('resolves the system proxy for the configured BilliardBuddy gateway', async () => {
    const resolveSystemProxy = vi.fn(async () => 'DIRECT')
    const runtime = new ElectronServerRuntime({
      desktopRoot: '/desktop',
      resolveSystemProxy,
      resolveGatewayConfig: () => ({ url: 'https://gateway.example/gw' }),
    }) as unknown as { resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> }

    await runtime.resolveSidecarBaseEnvOnce()

    expect(resolveSystemProxy).toHaveBeenCalledWith('https://gateway.example/gw')
  })

  it('falls back instead of blocking sidecar startup when system proxy resolution hangs', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const runtime = new ElectronServerRuntime({
      desktopRoot: '/desktop',
      resolveSystemProxy: () => new Promise(() => undefined),
      resolveGatewayConfig: () => ({ url: 'https://gateway.example/gw' }),
      systemProxyTimeoutMs: 5,
    }) as unknown as { resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> }

    await expect(runtime.resolveSidecarBaseEnvOnce()).resolves.toBeDefined()
    expect(diagnostic).toHaveBeenCalledWith(
      '[desktop] failed to resolve system proxy for sidecars',
      expect.any(Error),
    )
    diagnostic.mockRestore()
  })

  it('waits for the old child exit before spawning exactly one replacement', async () => {
    const runtime = new ElectronServerRuntime({ desktopRoot: '/desktop' }) as unknown as {
      server: { url: string; child: ReturnType<typeof child> } | null
      startServer: ReturnType<typeof vi.fn>
      reconfigureServer(): Promise<void>
    }
    const old = deferredChild()
    const fresh = child()
    runtime.server = { url: 'http://127.0.0.1:1', child: old }
    runtime.startServer = vi.fn(async () => {
      runtime.server = { url: 'http://127.0.0.1:2', child: fresh }
      return 'http://127.0.0.1:2'
    })

    const rotations = Promise.all([runtime.reconfigureServer(), runtime.reconfigureServer(), runtime.reconfigureServer()])
    await Promise.resolve()
    expect(old.kill).toHaveBeenCalledTimes(1)
    expect(runtime.startServer).not.toHaveBeenCalled()
    old.exitCode = 0
    old.emit('exit', 0, null)
    await rotations
    expect(runtime.startServer).toHaveBeenCalledTimes(1)
    expect(runtime.server?.child).toBe(fresh)
  })

  it('does not restart a sidecar after shutdown begins', async () => {
    const runtime = new ElectronServerRuntime({ desktopRoot: '/desktop' }) as unknown as {
      server: { url: string; child: ReturnType<typeof child> } | null
      startServer: ReturnType<typeof vi.fn>
      stopAll(sync?: boolean): void
      reconfigureServer(): Promise<void>
    }
    const old = child()
    runtime.server = { url: 'http://127.0.0.1:1', child: old }
    runtime.startServer = vi.fn()

    const stopping = runtime.stopAll()
    old.exitCode = 0
    old.emit('exit', 0, null)
    await stopping
    await runtime.reconfigureServer()
    expect(old.kill).toHaveBeenCalledTimes(1)
    expect(runtime.startServer).not.toHaveBeenCalled()
  })
})
