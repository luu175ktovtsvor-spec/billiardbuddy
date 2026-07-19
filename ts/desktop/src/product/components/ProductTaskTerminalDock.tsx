import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import { useTranslation, type TranslationKey } from '../../i18n'
import { terminalApi } from '../../api/terminal'
import { getDesktopHost } from '../../lib/desktopHost'
import {
  attachTerminalRuntime,
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

function findScrollableAncestor(element: HTMLElement, deltaY: number): HTMLElement | null {
  let parent = element.parentElement
  while (parent) {
    const style = window.getComputedStyle(parent)
    const canScrollY = style.overflowY === 'auto' || style.overflowY === 'scroll'
    if (canScrollY && parent.scrollHeight > parent.clientHeight) {
      const maxScrollTop = parent.scrollHeight - parent.clientHeight
      const canMove = deltaY < 0 ? parent.scrollTop > 0 : parent.scrollTop < maxScrollTop
      if (canMove) return parent
    }
    parent = parent.parentElement
  }
  return null
}

export type ProductTaskTerminalDockProps = {
  taskId: string
  workDir: string
  active?: boolean
  onClose?: () => void
  testId?: string
}

/** Product-task-bound terminal runtime. It never receives a Core session id. */
export function ProductTaskTerminalDock({
  taskId,
  workDir,
  active = true,
  onClose,
  testId = 'product-task-terminal-host',
}: ProductTaskTerminalDockProps) {
  const t = useTranslation()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const runtimeId = `product-task-terminal-${taskId}`
  const runtimeRef = useRef<TerminalRuntime | null>(null)
  if (!runtimeRef.current || runtimeRef.current.id !== runtimeId) {
    runtimeRef.current = getTerminalRuntime(runtimeId, terminalApi.isAvailable() ? 'idle' : 'unavailable')
  }
  const runtime = runtimeRef.current
  const [, forceRuntimeUpdate] = useState(0)
  const status = runtime.status
  const error = runtime.error
  const shellInfo = runtime.shellInfo
  useEffect(() => {
    return subscribeTerminalRuntime(runtime, () => forceRuntimeUpdate((value) => value + 1))
  }, [runtime])

  const resizeSession = useCallback(() => {
    const terminal = runtime.terminal
    const fit = runtime.fit
    const sessionId = runtime.nativeSessionId
    if (!terminal || !fit) return

    fit.fit()
    if (sessionId) {
      void terminalApi.resize(sessionId, terminal.cols, terminal.rows).catch(() => {})
    }
  }, [runtime])

  const startTerminal = useCallback(async () => {

    if (runtime.status === 'starting') return

    if (!terminalApi.isAvailable()) {
      updateTerminalRuntime(runtime, { status: 'unavailable' })
      return
    }

    const host = hostRef.current
    if (!host) return

    updateTerminalRuntime(runtime, { error: null, status: 'starting', shellInfo: null })

    const existing = runtime.nativeSessionId
    if (existing) {
      await terminalApi.kill(existing).catch(() => {})
      runtime.nativeSessionId = null
    }
    runtime.dataDisposable?.dispose()
    runtime.dataDisposable = null
    runtime.unlisteners.forEach((unlisten) => unlisten())
    runtime.unlisteners = []

    runtime.terminal?.dispose()
    runtime.terminal = null
    runtime.fit = null
    host.innerHTML = ''

    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ])

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "var(--font-mono), 'SFMono-Regular', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 4000,
      theme: {
        background: '#121212',
        foreground: '#d7d2d0',
        cursor: '#ffb59f',
        selectionBackground: '#5f4a40',
        black: '#1f1f1f',
        red: '#ff6d67',
        green: '#7ef18a',
        yellow: '#f8c55f',
        blue: '#77a8ff',
        magenta: '#d699ff',
        cyan: '#61d6d6',
        white: '#d7d2d0',
        brightBlack: '#8f8683',
        brightRed: '#ff8a85',
        brightGreen: '#9ff7a7',
        brightYellow: '#ffdd7a',
        brightBlue: '#a6c5ff',
        brightMagenta: '#e3b8ff',
        brightCyan: '#8ceeee',
        brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    updateTerminalRuntime(runtime, { terminal, fit })
    fit.fit()

    const outputUnlisten = await terminalApi.onOutput((payload) => {
      if (payload.session_id === runtime.nativeSessionId) {
        terminal.write(payload.data)
      }
    })
    const exitUnlisten = await terminalApi.onExit((payload) => {
      if (payload.session_id !== runtime.nativeSessionId) return
      updateTerminalRuntime(runtime, { status: 'exited' })
      const signal = payload.signal ? `, ${payload.signal}` : ''
      terminal.writeln(`\r\n[process exited: ${payload.code}${signal}]`)
      updateTerminalRuntime(runtime, { nativeSessionId: null })
    })
    runtime.unlisteners = [outputUnlisten, exitUnlisten]

    runtime.dataDisposable = terminal.onData((data) => {
      const sessionId = runtime.nativeSessionId
      if (sessionId) {
        void terminalApi.write(sessionId, data).catch((err) => {
          updateTerminalRuntime(runtime, {
            error: err instanceof Error ? err.message : String(err),
            status: 'error',
          })
        })
      }
    })

    try {
      const result = await terminalApi.spawn({
        cols: terminal.cols,
        rows: terminal.rows,
        cwd: workDir,
      })
      updateTerminalRuntime(runtime, {
        nativeSessionId: result.session_id,
        shellInfo: { shell: result.shell, cwd: result.cwd },
        status: 'running',
      })
      resizeSession()
    } catch (err) {
      outputUnlisten()
      exitUnlisten()
      terminal.dispose()
      updateTerminalRuntime(runtime, {
        terminal: null,
        fit: null,
        error: err instanceof Error ? err.message : String(err),
        status: 'error',
      })
    }
  }, [resizeSession, runtime, workDir])

  useEffect(() => {
    if (!terminalApi.isAvailable()) return
    if (runtime.terminal) {
      if (hostRef.current) {
        attachTerminalRuntime(runtime, hostRef.current)
      }
      resizeSession()
    } else {
      void startTerminal()
    }

    const observer = new ResizeObserver(() => resizeSession())
    if (hostRef.current) observer.observe(hostRef.current)

    return () => {
      observer.disconnect()
      destroyTerminalRuntime(runtime.id)
    }
  }, [resizeSession, runtime, startTerminal])

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => resizeSession())
    }
  }, [active, resizeSession])

  const clearTerminal = () => {
    runtime.terminal?.clear()
  }

  const handleTerminalWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const host = hostRef.current
    if (!host || host.contains(document.activeElement)) return

    const scroller = findScrollableAncestor(event.currentTarget, event.deltaY)
    if (!scroller) return

    event.preventDefault()
    event.stopPropagation()
    scroller.scrollBy({ top: event.deltaY, left: event.deltaX })
  }, [])

  const handleTerminalKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const terminal = runtime.terminal
    if (!terminal) return

    if (isTerminalCopyShortcut(event, terminal)) {
      event.preventDefault()
      event.stopPropagation()
      void copyTerminalSelection(terminal).catch(() => {})
      return
    }

    if (isTerminalPasteShortcut(event)) {
      event.preventDefault()
      event.stopPropagation()
      void pasteClipboardIntoTerminal(terminal).catch(() => {})
    }
  }, [runtime])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--color-surface-container-lowest)] px-3 py-1.5">
      <div
        data-testid="product-task-terminal-toolbar"
        className="mb-1.5 flex min-h-8 min-w-0 flex-wrap items-center gap-2"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-danger)]" aria-hidden="true" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-warning)]" aria-hidden="true" />
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--color-terminal-accent)]" aria-hidden="true" />
          <h2 className="shrink-0 text-[13px] font-semibold text-[var(--color-text-primary)]">
            {t('settings.terminal.title')}
          </h2>
          <StatusPill status={status} label={t(STATUS_LABEL_KEYS[status])} compact />
          {shellInfo && (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
              <span className="shrink-0 font-mono">{shellInfo.shell}</span>
              <span className="shrink-0 text-[var(--color-border)]">/</span>
              <span className="min-w-0 truncate font-mono">{shellInfo.cwd}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={clearTerminal}
            disabled={!runtime.terminal}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">mop</span>
            {t('settings.terminal.clear')}
          </button>
          <button
            type="button"
            onClick={() => void startTerminal()}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-text-primary)] px-2.5 text-xs font-medium text-[var(--color-surface)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {t('settings.terminal.restart')}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('terminal.closePanel')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
            >
              <span className="material-symbols-outlined text-[17px]">close</span>
            </button>
          ) : null}
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-error)]/20 bg-[var(--color-error)]/10 px-3 py-2 text-sm text-[var(--color-error)]">
          {error}
        </div>
      )}

      {status === 'unavailable' ? (
        <div className="flex flex-1 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-8 text-center">
          <div>
            <span className="material-symbols-outlined mb-3 block text-[32px] text-[var(--color-text-tertiary)]">
              desktop_windows
            </span>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">
              {t('settings.terminal.unavailableTitle')}
            </p>
            <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">
              {t('settings.terminal.unavailableBody')}
            </p>
          </div>
        </div>
      ) : (
        <div
          data-testid="product-task-terminal-frame"
          onKeyDownCapture={handleTerminalKeyDownCapture}
          onWheelCapture={handleTerminalWheelCapture}
          className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-terminal-border)] bg-[var(--color-terminal-bg)] shadow-[var(--shadow-dropdown)]"
        >
          <div
            ref={hostRef}
            data-testid={testId}
            className="product-task-terminal-host h-full w-full overflow-hidden px-2 pb-2 pt-1.5"
          />
        </div>
      )}
    </div>
  )
}

type TerminalKeyboardEvent = Pick<KeyboardEvent<HTMLElement>, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>
type ClipboardTerminal = {
  focus(): void
  getSelection(): string
  hasSelection(): boolean
  paste(data: string): void
}

function isApplePlatform() {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform)
}

function isWindowsPlatform() {
  if (typeof navigator === 'undefined') return false
  return /Win/i.test(navigator.platform || navigator.userAgent)
}

function normalizedKey(event: TerminalKeyboardEvent) {
  return event.key.toLowerCase()
}

function isTerminalCopyShortcut(event: TerminalKeyboardEvent, terminal: ClipboardTerminal) {
  if (event.altKey || !terminal.hasSelection()) return false

  const key = normalizedKey(event)
  if (isApplePlatform()) {
    return event.metaKey && !event.ctrlKey && key === 'c'
  }

  if (key === 'insert') {
    return event.ctrlKey && !event.shiftKey && !event.metaKey
  }

  if (isWindowsPlatform() && event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c') {
    return true
  }

  return event.ctrlKey && !event.metaKey && event.shiftKey && key === 'c'
}

function isTerminalPasteShortcut(event: TerminalKeyboardEvent) {
  if (event.altKey) return false

  const key = normalizedKey(event)
  if (isApplePlatform()) {
    return event.metaKey && !event.ctrlKey && key === 'v'
  }

  if (key === 'insert') {
    return event.shiftKey && !event.ctrlKey && !event.metaKey
  }

  if (isWindowsPlatform() && event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'v') {
    return true
  }

  return event.ctrlKey && !event.metaKey && event.shiftKey && key === 'v'
}

async function copyTerminalSelection(terminal: ClipboardTerminal) {
  const text = terminal.getSelection()
  if (!text) return
  await getDesktopHost().clipboard.writeText(text)
  terminal.focus()
}

async function pasteClipboardIntoTerminal(terminal: ClipboardTerminal) {
  const text = await getDesktopHost().clipboard.readText()
  if (!text) return
  terminal.paste(text)
  terminal.focus()
}

function StatusPill({ status, label, compact = false }: { status: TerminalStatus; label: string; compact?: boolean }) {
  const color =
    status === 'running'
      ? 'bg-[var(--color-success)]'
      : status === 'error'
        ? 'bg-[var(--color-error)]'
        : status === 'starting'
          ? 'bg-[var(--color-warning)]'
          : 'bg-[var(--color-text-tertiary)]'

  return (
    <span className={`inline-flex ${compact ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-[11px]'} shrink-0 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-low)] font-medium text-[var(--color-text-secondary)]`}>
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  )
}
