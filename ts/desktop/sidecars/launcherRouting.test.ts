import { describe, expect, it } from 'vitest'

import { parseLauncherArgs, resolveSidecarInvocation } from './launcherRouting'

describe('resolveSidecarInvocation', () => {
  it('keeps explicit sidecar modes unchanged', () => {
    expect(
      resolveSidecarInvocation(
        ['server', '--host', '127.0.0.1'],
        null,
      ),
    ).toEqual({
      mode: 'server',
      restArgs: ['--host', '127.0.0.1'],
      defaultAppRoot: null,
    })
  })

  it('accepts the internal agent worker and rejects the retired public CLI mode', () => {
    expect(resolveSidecarInvocation(['agent-worker'], '/app/root')).toEqual({
      mode: 'agent-worker',
      restArgs: [],
      defaultAppRoot: '/app/root',
    })
    expect(resolveSidecarInvocation(['cli'], '/app/root').mode).toBeNull()
  })

  it('recognizes Chrome native-host launches by their extension origin', () => {
    expect(resolveSidecarInvocation([
      'chrome-extension://bloolcbpfgdgmimikocneolpiickndlk/',
      '--parent-window=0',
    ], null)).toEqual({
      mode: 'browser-host',
      restArgs: [
        'chrome-extension://bloolcbpfgdgmimikocneolpiickndlk/',
        '--parent-window=0',
      ],
      defaultAppRoot: null,
    })
  })
})

describe('parseLauncherArgs', () => {
  it('falls back to the provided default app root', () => {
    expect(
      parseLauncherArgs(['plugin', 'install', 'demo'], '/Users/demo/.local/bin'),
    ).toEqual({
      appRoot: '/Users/demo/.local/bin',
      args: ['plugin', 'install', 'demo'],
    })
  })

  it('lets explicit app root override the default', () => {
    expect(
      parseLauncherArgs(
        ['--app-root', '/tmp/app', 'plugin', 'install', 'demo'],
        '/Users/demo/.local/bin',
      ),
    ).toEqual({
      appRoot: '/tmp/app',
      args: ['plugin', 'install', 'demo'],
    })
  })
})
