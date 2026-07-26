import { execFileSync, spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import {
  ElectronTerminalService,
  defaultShell,
  desktopTerminalSettingsPath,
  ensureUtf8Locale,
  normalizeTerminalBashPath,
  parseEnvBlock,
  prepareNodePtyRuntime,
  resolveDesktopTerminalShell,
  spawnTerminalWatchdog,
  terminalWatchdogPlan,
  terminalEnvironment,
  terminalConfigPath,
  type TerminalPtyFactory,
  type TerminalPtyProcess,
} from './terminal'

class FakePty implements TerminalPtyProcess {
  pid?: number
  writes: string[] = []
  resizes: Array<{ cols: number, rows: number }> = []
  killed = false
  private dataHandler: ((data: string) => void) | null = null
  private exitHandler: ((event: { exitCode: number, signal?: number | string | null }) => void) | null = null

  write(data: string) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows })
  }

  kill() {
    this.killed = true
  }

  onData(handler: (data: string) => void) {
    this.dataHandler = handler
  }

  onExit(handler: (event: { exitCode: number, signal?: number | string | null }) => void) {
    this.exitHandler = handler
  }

  emitData(data: string) {
    this.dataHandler?.(data)
  }

  emitExit(event: { exitCode: number, signal?: number | string | null }) {
    this.exitHandler?.(event)
  }
}

const tempDirs: string[] = []
const itOnDarwin = process.platform === 'darwin' ? it : it.skip
const itLivePty = process.platform !== 'win32' && process.env.BB_LIVE_PTY_TEST === '1' ? it : it.skip

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billiardbuddy-terminal-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe('Electron terminal service', () => {
  it('uses the portable terminal config path before app userData', () => {
    const app = { getPath: vi.fn(() => '/app/user-data') }

    expect(terminalConfigPath(app, { BILLIARDBUDDY_CONFIG_DIR: '/portable' })).toBe('/portable/terminal-config.json')
    expect(terminalConfigPath(app, {})).toBe('/app/user-data/terminal-config.json')
  })

  it('persists the legacy bash path config and validates saved paths', () => {
    const dir = tempDir()
    const bash = path.join(dir, 'bash.exe')
    fs.writeFileSync(bash, '')
    const service = new ElectronTerminalService({
      env: { BILLIARDBUDDY_CONFIG_DIR: dir },
      isFile: filePath => filePath === bash,
    })

    service.setBashPath(` ${bash} `)
    expect(service.getBashPath()).toBe(bash)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'terminal-config.json'), 'utf8'))).toEqual({
      bash_path: bash,
    })
    expect(() => service.setBashPath('/missing/bash')).toThrow('terminal bash path does not exist')
    expect(normalizeTerminalBashPath('   ', () => false)).toBeNull()
  })

  it('resolves platform-specific shells from the desktop settings contract', () => {
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'pwsh' })).toBe('pwsh.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'powershell' })).toBe('powershell.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'cmd' })).toBe('cmd.exe')
    expect(resolveDesktopTerminalShell('win32', { startupShell: 'custom', customShellPath: ' C:\\Tools\\shell.exe ' })).toBe('C:\\Tools\\shell.exe')
    expect(() => resolveDesktopTerminalShell('win32', { startupShell: 'custom' })).toThrow('custom terminal shell path is empty')
    expect(resolveDesktopTerminalShell('darwin', { startupShell: 'pwsh' })).toBeNull()
  })

  it('prefers Windows custom bash when valid and falls back to COMSPEC', () => {
    expect(defaultShell('win32', { COMSPEC: 'cmd.exe' }, 'C:\\Git\\bin\\bash.exe', file => file.endsWith('bash.exe'))).toBe(
      'C:\\Git\\bin\\bash.exe',
    )
    expect(defaultShell('win32', { COMSPEC: 'cmd.exe' }, 'C:\\missing\\bash.exe', () => false)).toBe('cmd.exe')
    expect(defaultShell('linux', { SHELL: '/bin/fish' }, null, () => false)).toBe('/bin/fish')
  })

  it('reads desktop terminal settings from the BilliardBuddy config directory', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, '.BilliardBuddy'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.BilliardBuddy', 'settings.json'),
      JSON.stringify({ desktopTerminal: { startupShell: 'cmd' } }),
    )

    const service = new ElectronTerminalService({
      env: { HOME: dir, COMSPEC: 'powershell.exe' },
      platform: 'win32',
    })

    expect(desktopTerminalSettingsPath({ HOME: dir })).toBe(path.join(dir, '.BilliardBuddy', 'settings.json'))
    expect(service.resolveShell()).toBe('cmd.exe')
  })

  it('normalizes terminal environment data to UTF-8 locale', () => {
    expect(parseEnvBlock(Buffer.from('A=1\0B=two=2\0\0'))).toEqual({ A: '1', B: 'two=2' })
    expect(ensureUtf8Locale({ LANG: 'C' }, 'darwin')).toMatchObject({
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    })
  })

  it('does not expose product-managed credentials to the user terminal', () => {
    expect(terminalEnvironment('/missing/shell', 'linux', {
      PATH: '/usr/bin',
      BB_GATEWAY_BOOTSTRAP_CREDENTIAL: 'bootstrap-secret',
      BB_GATEWAY_TOKEN: 'access-secret',
      BB_BROWSER_UI_CAPABILITY: 'browser-secret',
    })).toMatchObject({ PATH: '/usr/bin' })
    expect(terminalEnvironment('/missing/shell', 'linux', {
      BB_GATEWAY_TOKEN: 'access-secret',
    })).not.toHaveProperty('BB_GATEWAY_TOKEN')
  })

  it('builds crash watchdogs without forwarding the desktop environment', () => {
    const windows = terminalWatchdogPlan(7001, 9001, 'win32', {
      SystemRoot: 'C:\\Windows',
      BB_GATEWAY_TOKEN: 'must-not-leak',
    })
    expect(windows.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(windows.args.join(' ')).toContain('Wait-Process -Id 7001')
    expect(windows.args.join(' ')).toContain('/PID 9001 /T /F')
    expect(windows.env).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      PATH: 'C:\\Windows\\System32',
    })
    expect(JSON.stringify(windows)).not.toContain('must-not-leak')

    const unix = terminalWatchdogPlan(7001, 9001, 'darwin', { BB_GATEWAY_TOKEN: 'must-not-leak' })
    expect(unix.command).toBe('/bin/sh')
    expect(unix.args).toContain('7001')
    expect(unix.args).toContain('9001')
    expect(unix.env).toEqual({ PATH: '/usr/bin:/bin' })
  })

  it('copies packaged node-pty to a writable runtime cache and restores helper executable bits', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    const helper = path.join(source, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    fs.mkdirSync(path.dirname(helper), { recursive: true })
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() {} }\n')
    fs.writeFileSync(helper, 'helper')
    fs.chmodSync(helper, 0o644)

    expect(prepareNodePtyRuntime(source, cache)).toBe(cache)
    expect(fs.existsSync(path.join(cache, 'index.js'))).toBe(true)
    expect(fs.statSync(cache).mode & 0o077).toBe(0)
    expect(fs.statSync(path.join(cache, 'prebuilds', 'darwin-arm64', 'spawn-helper')).mode & 0o777).toBe(0o500)
    expect(fs.existsSync(path.join(cache, '.bb-node-pty-manifest.json'))).toBe(true)
  })

  it('rebuilds the packaged node-pty runtime cache when cached files are tampered', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() { return "source" } }\n')

    prepareNodePtyRuntime(source, cache)
    fs.writeFileSync(path.join(cache, 'index.js'), 'module.exports = { spawn() { return "tampered" } }\n')

    prepareNodePtyRuntime(source, cache)

    expect(fs.readFileSync(path.join(cache, 'index.js'), 'utf8')).toBe('module.exports = { spawn() { return "source" } }\n')
  })

  itOnDarwin('removes stale macOS quarantine attributes from the node-pty runtime cache', () => {
    const source = tempDir()
    const cache = path.join(tempDir(), 'node-pty-cache')
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'node-pty', main: 'index.js' }))
    fs.writeFileSync(path.join(source, 'index.js'), 'module.exports = { spawn() { return "source" } }\n')

    prepareNodePtyRuntime(source, cache)

    const cachedEntry = path.join(cache, 'index.js')
    execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0381;00000000;Chrome;BILLIARDBUDDY-TEST', cachedEntry])
    execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', cachedEntry], { stdio: 'ignore' })
    fs.chmodSync(cachedEntry, 0o500)

    prepareNodePtyRuntime(source, cache)

    expect(() => execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', cachedEntry], { stdio: 'ignore' })).toThrow()
    expect(fs.statSync(cachedEntry).mode & 0o777).toBe(0o500)
  })

  it('spawns a PTY, forwards events, and controls the active session', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const spawn = vi.fn(() => fakePty)
    const sent: Array<{ channel: string, payload: unknown }> = []
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn } satisfies TerminalPtyFactory,
      fileExists: filePath => filePath === '/bin/test-shell',
    })

    const session = await service.spawn(
      { taskId: 'task-1', cols: 10, rows: 4, cwd: dir },
      { id: 41, send: (channel, payload) => sent.push({ channel, payload }) },
    )

    expect(session).toEqual({ session_id: 1, shell: '/bin/test-shell', cwd: dir })
    expect(spawn).toHaveBeenCalledWith('/bin/test-shell', [], expect.objectContaining({
      name: 'xterm-256color',
      cols: 20,
      rows: 8,
      cwd: dir,
      env: expect.objectContaining({
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }),
    }))

    service.write(41, 'task-1', 1, 'echo hello\r')
    service.resize(41, 'task-1', 1, 12, 6)
    fakePty.emitData('hello\r\n')
    fakePty.emitExit({ exitCode: 0 })

    expect(fakePty.writes).toEqual(['echo hello\r'])
    expect(fakePty.resizes).toEqual([{ cols: 20, rows: 8 }])
    expect(sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.terminalOutput,
        payload: { session_id: 1, data: 'hello\r\n' },
      },
      {
        channel: ELECTRON_EVENT_CHANNELS.terminalExit,
        payload: { session_id: 1, code: 0, signal: null },
      },
    ])
    expect(() => service.write(41, 'task-1', 1, 'after exit')).toThrow('terminal session is not running')
  })

  it('kills a running PTY session without failing when the session is already gone', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
    })

    await service.spawn({ taskId: 'task-1', cols: 80, rows: 24, cwd: dir }, { id: 41, send: vi.fn() })
    expect(() => service.write(41, 'task-2', 1, 'pwd\r')).toThrow('terminal session is not owned by this task')
    expect(() => service.resize(42, 'task-1', 1, 80, 24)).toThrow('terminal session is not owned by this task')
    service.kill(41, 'task-1', 1)
    service.kill(41, 'task-1', 1)

    expect(fakePty.killed).toBe(true)
  })

  it('kills only sessions owned by a renderer when that renderer is gone', async () => {
    const dir = tempDir()
    const first = new FakePty()
    const second = new FakePty()
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) },
    })

    await service.spawn({ taskId: 'task-1', cwd: dir }, { id: 41, send: vi.fn() })
    await service.spawn({ taskId: 'task-2', cwd: dir }, { id: 42, send: vi.fn() })
    service.killOwner(41)

    expect(first.killed).toBe(true)
    expect(second.killed).toBe(false)
    expect(() => service.write(42, 'task-2', 2, 'pwd\r')).not.toThrow()
  })

  it('stops the native crash watchdog when a PTY exits normally', async () => {
    const dir = tempDir()
    const fakePty = new FakePty()
    fakePty.pid = 9001
    const watchdog = { kill: vi.fn(), unref: vi.fn() }
    const watchdogFactory = vi.fn(() => watchdog)
    const service = new ElectronTerminalService({
      env: { HOME: dir, SHELL: '/bin/test-shell' },
      platform: 'linux',
      ptyFactory: { spawn: vi.fn(() => fakePty) },
      ownerProcessId: 7001,
      watchdogFactory,
    })

    await service.spawn({ taskId: 'task-1', cwd: dir }, { id: 41, send: vi.fn() })
    expect(watchdogFactory).toHaveBeenCalledWith(7001, 9001)
    fakePty.emitExit({ exitCode: 0 })
    expect(watchdog.kill).toHaveBeenCalledOnce()
  })

  itLivePty('runs a real interactive node-pty in the owning workspace', async () => {
    const dir = tempDir()
    const output: string[] = []
    let finish: (() => void) | undefined
    let finishOutput: (() => void) | undefined
    const exited = new Promise<void>(resolve => { finish = resolve })
    const observedWorkspace = new Promise<void>(resolve => { finishOutput = resolve })
    const service = new ElectronTerminalService({
      env: { ...process.env, HOME: dir, SHELL: '/bin/zsh' },
      platform: process.platform,
      ptyFactory: await import('node-pty'),
    })

    const session = await service.spawn(
      { taskId: 'task-real', cols: 80, rows: 24, cwd: dir },
      {
        id: 77,
        send: (channel, payload) => {
          if (channel === ELECTRON_EVENT_CHANNELS.terminalOutput) {
            output.push((payload as { data: string }).data)
            if (output.join('').includes(dir)) finishOutput?.()
          }
          if (channel === ELECTRON_EVENT_CHANNELS.terminalExit) finish?.()
        },
      },
    )
    service.write(77, 'task-real', session.session_id, 'printf "BB_PTY_REAL\\n"; pwd\r')
    await observedWorkspace
    service.write(77, 'task-real', session.session_id, 'exit\r')
    await exited

    const transcript = output.join('').replaceAll('\r', '')
    expect(transcript).toContain('BB_PTY_REAL')
    expect(transcript).toContain(dir)
  }, 10_000)

  itLivePty('hangs up the foreground PTY process when its native owner crashes', async () => {
    const nodePtyEntry = createRequire(import.meta.url).resolve('node-pty')
    const owner = spawnChild(process.execPath, ['-e', [
      `const pty = require(${JSON.stringify(nodePtyEntry)})`,
      "const child = pty.spawn('/bin/zsh', ['-c', 'sleep 300'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })",
      'process.stdout.write(String(child.pid) + "\\n")',
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: ['ignore', 'pipe', 'pipe'] })
    const foregroundPid = await new Promise<number>((resolve, reject) => {
      let stdout = ''
      owner.stdout.setEncoding('utf8')
      owner.stdout.on('data', chunk => {
        stdout += chunk
        const line = stdout.split('\n')[0]?.trim()
        if (line && /^\d+$/.test(line)) resolve(Number(line))
      })
      owner.once('error', reject)
      owner.stderr.once('data', chunk => reject(new Error(String(chunk))))
    })
    const watchdog = spawnTerminalWatchdog(owner.pid!, foregroundPid)

    owner.kill('SIGKILL')
    await new Promise<void>(resolve => owner.once('exit', () => resolve()))

    let foregroundRunning = true
    for (let attempt = 0; attempt < 50 && foregroundRunning; attempt += 1) {
      try {
        process.kill(foregroundPid, 0)
        await new Promise(resolve => setTimeout(resolve, 20))
      } catch {
        foregroundRunning = false
      }
    }
    if (foregroundRunning) process.kill(foregroundPid, 'SIGKILL')
    watchdog?.kill()
    expect(foregroundRunning).toBe(false)
  }, 10_000)
})
