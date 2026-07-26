import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserHost } from '../lib/desktopHost/browserHost'

describe('terminalApi desktop host bridge', () => {
  beforeEach(() => {
    vi.resetModules()
    Reflect.deleteProperty(window, 'desktopHost')
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
  })

  it('routes terminal commands through an injected desktop host', async () => {
    const spawn = vi.fn().mockResolvedValue({
      session_id: 9,
      shell: '/bin/zsh',
      cwd: '/tmp/project',
    })
    const write = vi.fn().mockResolvedValue(undefined)
    const resize = vi.fn().mockResolvedValue(undefined)
    const kill = vi.fn().mockResolvedValue(undefined)
    const onOutput = vi.fn().mockResolvedValue(() => {})
    const onExit = vi.fn().mockResolvedValue(() => {})
    const getBashPath = vi.fn().mockResolvedValue('/bin/bash')
    const setBashPath = vi.fn().mockResolvedValue(undefined)

    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        terminal: true,
      },
      terminal: {
        spawn,
        write,
        resize,
        kill,
        onOutput,
        onExit,
        getBashPath,
        setBashPath,
      },
    }

    const { terminalApi } = await import('./terminal')
    const outputHandler = vi.fn()
    const exitHandler = vi.fn()

    await expect(terminalApi.spawn({ taskId: 'task-1', cols: 80, rows: 24, cwd: '/tmp/project' })).resolves.toEqual({
      session_id: 9,
      shell: '/bin/zsh',
      cwd: '/tmp/project',
    })
    await terminalApi.write('task-1', 9, 'ls\n')
    await terminalApi.resize('task-1', 9, 100, 30)
    await terminalApi.kill('task-1', 9)
    await terminalApi.onOutput(outputHandler)
    await terminalApi.onExit(exitHandler)
    await expect(terminalApi.getBashPath()).resolves.toBe('/bin/bash')
    await terminalApi.setBashPath('/opt/bash')

    expect(terminalApi.isAvailable()).toBe(true)
    expect(spawn).toHaveBeenCalledWith({ taskId: 'task-1', cols: 80, rows: 24, cwd: '/tmp/project' })
    expect(write).toHaveBeenCalledWith('task-1', 9, 'ls\n')
    expect(resize).toHaveBeenCalledWith('task-1', 9, 100, 30)
    expect(kill).toHaveBeenCalledWith('task-1', 9)
    expect(onOutput).toHaveBeenCalledWith(outputHandler)
    expect(onExit).toHaveBeenCalledWith(exitHandler)
    expect(setBashPath).toHaveBeenCalledWith('/opt/bash')
  })

  it('keeps terminal unavailable in browser fallback', async () => {
    const { terminalApi } = await import('./terminal')

    expect(terminalApi.isAvailable()).toBe(false)
    expect(() => terminalApi.spawn({ taskId: 'task-1', cols: 80, rows: 24 })).toThrow(
      'Terminal is available in the desktop app runtime.',
    )
  })
})
