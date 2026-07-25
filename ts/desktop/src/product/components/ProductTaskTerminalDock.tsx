import { useCallback, useEffect, useRef, useState } from 'react'
import { terminalApi } from '../../api/terminal'
import { useTranslation, type TranslationKey } from '../../i18n'
import {
  destroyTerminalRuntime,
  getTerminalRuntime,
  subscribeTerminalRuntime,
  updateTerminalRuntime,
  type TerminalRuntime,
  type TerminalStatus,
} from '../../lib/terminalRuntime'

const STATUS_LABEL_KEYS: Record<TerminalStatus, TranslationKey> = {
  idle: 'settings.terminal.status.idle',
  starting: 'settings.terminal.status.starting',
  running: 'settings.terminal.status.running',
  exited: 'settings.terminal.status.exited',
  error: 'settings.terminal.status.error',
  unavailable: 'settings.terminal.status.unavailable',
}

export type ProductTaskTerminalDockProps = {
  taskId: string
  workDir?: string
  workspaceAvailable?: boolean
  onClose?: () => void
  active?: boolean
  testId?: string
}

/** A local user PTY bound to one ProductTask; it is separate from Agent tool execution. */
export function ProductTaskTerminalDock({
  taskId,
  workDir = '',
  workspaceAvailable = true,
  onClose,
  active = true,
  testId = 'product-task-terminal-host',
}: ProductTaskTerminalDockProps) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(false)
  const lifecycleRef = useRef(0)
  const runtimeId = `product-task-terminal-${taskId}`
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  if (!runtimeRef.current || runtimeRef.current.id !== runtimeId) {
    const available = workspaceAvailable && Boolean(workDir.trim()) && terminalApi.isAvailable()
    runtimeRef.current = getTerminalRuntime(runtimeId, available ? 'idle' : 'unavailable')
  }
  const runtime = runtimeRef.current
  const [, refresh] = useState(0)

  useEffect(() => subscribeTerminalRuntime(runtime, () => refresh(value => value + 1)), [runtime])

  const resize = useCallback(() => {
    if (!active || !runtime.terminal || !runtime.fit) return
    runtime.fit.fit()
    const sessionId = runtime.nativeSessionId
    if (sessionId) {
      void terminalApi.resize(taskId, sessionId, runtime.terminal.cols, runtime.terminal.rows).catch(error => {
        updateTerminalRuntime(runtime, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }, [active, runtime, taskId])

  const start = useCallback(async () => {
    const lifecycle = lifecycleRef.current
    const isCurrent = () => mountedRef.current && lifecycleRef.current === lifecycle
    if (!isCurrent() || runtime.status === 'starting') return
    if (!workspaceAvailable || !workDir.trim() || !terminalApi.isAvailable()) {
      updateTerminalRuntime(runtime, { status: 'unavailable' })
      return
    }
    const host = hostRef.current
    if (!host) return

    updateTerminalRuntime(runtime, { error: null, shellInfo: null, status: 'starting' })
    const existingSessionId = runtime.nativeSessionId
    if (existingSessionId) {
      await terminalApi.kill(taskId, existingSessionId).catch(() => {})
      if (!isCurrent()) return
    }
    runtime.nativeSessionId = null
    runtime.dataDisposable?.dispose()
    runtime.dataDisposable = null
    runtime.unlisteners.forEach(unlisten => unlisten())
    runtime.unlisteners = []
    runtime.terminal?.dispose()
    runtime.terminal = null
    runtime.fit = null
    host.replaceChildren()

    let createdTerminal: TerminalRuntime['terminal'] = null
    let spawnedSessionId: number | null = null
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ])
      if (!isCurrent()) return

      const terminal = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-mono), 'SFMono-Regular', Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 4000,
        theme: {
          background: '#121212',
          foreground: '#d7d2d0',
          cursor: '#ffb59f',
          selectionBackground: '#5f4a40',
        },
      })
      createdTerminal = terminal
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(host)
      updateTerminalRuntime(runtime, { terminal, fit })
      fit.fit()

      const outputUnlisten = await terminalApi.onOutput(payload => {
        if (payload.session_id === runtime.nativeSessionId) terminal.write(payload.data)
      })
      if (!isCurrent()) {
        outputUnlisten()
        terminal.dispose()
        return
      }
      const exitUnlisten = await terminalApi.onExit(payload => {
        if (payload.session_id !== runtime.nativeSessionId) return
        const signal = payload.signal ? `, ${payload.signal}` : ''
        terminal.writeln(`\r\n[process exited: ${payload.code}${signal}]`)
        updateTerminalRuntime(runtime, { nativeSessionId: null, status: 'exited' })
      })
      if (!isCurrent()) {
        outputUnlisten()
        exitUnlisten()
        terminal.dispose()
        return
      }
      runtime.unlisteners = [outputUnlisten, exitUnlisten]
      runtime.dataDisposable = terminal.onData(data => {
        const sessionId = runtime.nativeSessionId
        if (!sessionId) return
        void terminalApi.write(taskId, sessionId, data).catch(error => {
          updateTerminalRuntime(runtime, {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })

      const result = await terminalApi.spawn({
        taskId,
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: workDir,
      })
      spawnedSessionId = result.session_id
      if (!isCurrent()) {
        await terminalApi.kill(taskId, result.session_id).catch(() => {})
        return
      }
      updateTerminalRuntime(runtime, {
        nativeSessionId: result.session_id,
        shellInfo: { shell: result.shell, cwd: result.cwd },
        status: 'running',
      })
      fit.fit()
      await terminalApi.resize(taskId, result.session_id, terminal.cols, terminal.rows)
    } catch (error) {
      if (!isCurrent()) return
      if (spawnedSessionId) await terminalApi.kill(taskId, spawnedSessionId).catch(() => {})
      runtime.unlisteners.forEach(unlisten => unlisten())
      runtime.unlisteners = []
      runtime.dataDisposable?.dispose()
      runtime.dataDisposable = null
      createdTerminal?.dispose()
      updateTerminalRuntime(runtime, {
        terminal: null,
        fit: null,
        nativeSessionId: null,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [runtime, taskId, workDir, workspaceAvailable])

  useEffect(() => {
    lifecycleRef.current += 1
    mountedRef.current = true
    void start()
    const observer = new ResizeObserver(resize)
    if (hostRef.current) observer.observe(hostRef.current)
    return () => {
      mountedRef.current = false
      lifecycleRef.current += 1
      observer.disconnect()
      destroyTerminalRuntime(runtime.id, taskId)
    }
  }, [resize, runtime, start, taskId])

  useEffect(() => {
    if (active) requestAnimationFrame(resize)
  }, [active, resize])

  const unavailable = runtime.status === 'unavailable'
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface-container-lowest)] px-3 py-2">
      <div data-testid="product-task-terminal-toolbar" className="mb-2 flex min-h-8 items-center gap-2">
        <h2 className="text-[13px] font-semibold text-[var(--color-text-primary)]">{t('settings.terminal.title')}</h2>
        <span role="status" className="text-xs text-[var(--color-text-tertiary)]">{t(STATUS_LABEL_KEYS[runtime.status])}</span>
        {runtime.shellInfo ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-text-tertiary)]">
            {runtime.shellInfo.shell} · {runtime.shellInfo.cwd}
          </span>
        ) : <span className="flex-1" />}
        <button type="button" onClick={() => runtime.terminal?.clear()} disabled={!runtime.terminal} className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50">
          {t('settings.terminal.clear')}
        </button>
        <button type="button" onClick={() => void start()} disabled={unavailable || runtime.status === 'starting'} className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs disabled:opacity-50">
          {t('settings.terminal.restart')}
        </button>
        {onClose ? <button type="button" aria-label={t('terminal.closePanel')} onClick={onClose} className="rounded-md px-2 py-1 text-sm">×</button> : null}
      </div>
      {runtime.error ? <p role="alert" className="mb-2 text-xs text-[var(--color-error)]">{runtime.error}</p> : null}
      {unavailable ? (
        <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-tertiary)]">
          {t('settings.terminal.unavailableBody')}
        </div>
      ) : (
        <div data-testid="product-task-terminal-frame" className="min-h-0 flex-1 overflow-hidden rounded-md border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)]">
          <div ref={hostRef} data-testid={testId} className="h-full w-full overflow-hidden px-2 py-1.5" />
        </div>
      )}
    </div>
  )
}
