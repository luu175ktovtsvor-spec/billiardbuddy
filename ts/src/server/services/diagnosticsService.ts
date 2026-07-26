import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Dirent } from 'node:fs'

export type DiagnosticSeverity = 'debug' | 'info' | 'warn' | 'error'

export type DiagnosticEventInput = {
  type: string
  severity?: DiagnosticSeverity
  summary: string
  sessionId?: string
  details?: unknown
}

export type DiagnosticEvent = {
  id: string
  timestamp: string
  type: string
  severity: DiagnosticSeverity
  summary: string
  sessionId?: string
  details?: unknown
}

const RETENTION_DAYS = 7
const MAX_BYTES = 50 * 1024 * 1024
const MAX_STRING_LENGTH = 4096
const MAX_ARRAY_ITEMS = 40
const MAX_OBJECT_KEYS = 80
const SENSITIVE_KEY_RE = /(api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|\btoken\b|secret|password|authorization|cookie|oauth)/i
const CLIENT_EVENT_TYPES = new Set([
  'client_window_error',
  'client_unhandled_rejection',
  'client_react_error_boundary',
  'client_api_request_failed',
])

function isDiagnosticSeverity(value: unknown): value is DiagnosticSeverity {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

export class DiagnosticsService {
  private consoleCaptureInstalled = false
  private processCaptureInstalled = false
  private originalConsoleError: typeof console.error | null = null
  private originalConsoleWarn: typeof console.warn | null = null

  private getLogDir(): string {
    return path.join(this.getConfigDir(), 'billiardbuddy', 'diagnostics')
  }

  private getDiagnosticsPath(): string {
    return path.join(this.getLogDir(), 'diagnostics.jsonl')
  }

  private getRuntimeErrorsPath(): string {
    return path.join(this.getLogDir(), 'runtime-errors.log')
  }

  async recordEvent(input: DiagnosticEventInput): Promise<void> {
    // Test isolation: never let a test run write into the user's real
    // ~/.BilliardBuddy/billiardbuddy/diagnostics. Tests that genuinely exercise diagnostics
    // set BILLIARDBUDDY_CONFIG_DIR to a tmp dir; anything else under NODE_ENV=test is
    // a leak (e.g. a fire-and-forget recordEvent resolving after a test's
    // afterEach restored BILLIARDBUDDY_CONFIG_DIR) and must be dropped.
    if (process.env.NODE_ENV === 'test' && !process.env.BILLIARDBUDDY_CONFIG_DIR) return

    const event: DiagnosticEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: input.type,
      // Default to 'info', not 'error': an unclassified event is not evidence
      // of a failure. Only callers that know something went wrong pass 'error'.
      severity: input.severity ?? 'info',
      summary: this.sanitizeString(input.summary),
      ...(input.sessionId ? { sessionId: this.sanitizeString(input.sessionId, 256) } : {}),
      ...(input.details !== undefined ? { details: this.sanitizeValue(input.details) } : {}),
    }

    try {
      await this.ensureLogDir()
      await fs.appendFile(this.getDiagnosticsPath(), JSON.stringify(event) + '\n', 'utf-8')
      if (event.severity === 'warn' || event.severity === 'error') {
        await fs.appendFile(this.getRuntimeErrorsPath(), this.formatRuntimeLogEntry(event), 'utf-8')
      }
      await this.enforceRetention().catch(() => {})
    } catch {
      // Diagnostics must never break the product path.
    }
  }

  /**
   * Records a client-side incident without accepting renderer-controlled text,
   * request data, paths, URLs, session ids, or exception details. The raw
   * diagnostic store remains an internal server concern.
   */
  async recordClientEvent(input: { type?: unknown; severity?: unknown }): Promise<void> {
    const type = typeof input.type === 'string' && CLIENT_EVENT_TYPES.has(input.type)
      ? input.type
      : 'client_diagnostic_event'
    const severity: DiagnosticSeverity = isDiagnosticSeverity(input.severity)
      ? input.severity
      : 'info'
    await this.recordEvent({
      type,
      severity,
      summary: this.getClientIncidentSummary(type),
    })
  }

  /**
   * Mirror console.error / console.warn into the diagnostics stream.
   *
   * Contract for callers across the codebase: console.error means "error" and
   * console.warn means "warn" in the internal diagnostics stream. An expected, gracefully
   * handled state (token expiry, normal process shutdown, streaming partials,
   * recovered fallbacks) is NOT an error — log those with console.debug /
   * console.info / console.log, which are intentionally not captured here.
   * Otherwise the captured records fill with red noise and real failures get buried.
   */
  installConsoleCapture(): void {
    if (this.consoleCaptureInstalled) return
    this.consoleCaptureInstalled = true
    this.originalConsoleError = console.error.bind(console)
    this.originalConsoleWarn = console.warn.bind(console)

    console.error = (...args: unknown[]) => {
      this.originalConsoleError?.(...args)
      void this.recordEvent({
        type: 'console_error',
        severity: 'error',
        summary: this.formatConsoleArgs(args),
      })
    }

    console.warn = (...args: unknown[]) => {
      this.originalConsoleWarn?.(...args)
      void this.recordEvent({
        type: 'console_warn',
        severity: 'warn',
        summary: this.formatConsoleArgs(args),
      })
    }
  }

  restoreConsoleCaptureForTests(): void {
    if (this.originalConsoleError) console.error = this.originalConsoleError
    if (this.originalConsoleWarn) console.warn = this.originalConsoleWarn
    this.consoleCaptureInstalled = false
    this.originalConsoleError = null
    this.originalConsoleWarn = null
  }

  installProcessCapture(): void {
    if (this.processCaptureInstalled) return
    this.processCaptureInstalled = true

    process.on('uncaughtException', (error) => {
      this.writeProcessFailureToStderr('Uncaught exception', error)
      const fallbackExit = setTimeout(() => process.exit(1), 1000)
      fallbackExit.unref?.()
      void this.recordEvent({
        type: 'server_uncaught_exception',
        severity: 'error',
        summary: error.message || 'Uncaught exception',
        details: { error },
      }).finally(() => process.exit(1))
    })

    process.on('unhandledRejection', (reason) => {
      this.writeProcessFailureToStderr('Unhandled rejection', reason)
      void this.recordEvent({
        type: 'server_unhandled_rejection',
        severity: 'error',
        summary: this.formatUnknownReason(reason),
        details: { reason },
      })
    })
  }

  sanitizeValue(value: unknown, depth = 0): unknown {
    if (depth > 6) return '[TRUNCATED_DEPTH]'
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return this.sanitizeString(value)
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.sanitizeString(value.message),
      }
    }
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => this.sanitizeValue(entry, depth + 1))
    }
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {}
      let count = 0
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (count >= MAX_OBJECT_KEYS) {
          result.__truncatedKeys = true
          break
        }
        count += 1
        result[key] = SENSITIVE_KEY_RE.test(key)
          ? '[REDACTED]'
          : this.sanitizeValue(entry, depth + 1)
      }
      return result
    }
    return String(value)
  }

  sanitizeString(value: string, maxLength = MAX_STRING_LENGTH): string {
    let sanitized = value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s:@]+(?::[^/?#\s@]*)?@)/gi, '$1[REDACTED]@')
      .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[:=]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:api[_-]?key|token|auth|access_token|refresh_token|key)=)[^&\s]+/gi, '$1[REDACTED]')

    const home = os.homedir()
    if (home && sanitized.includes(home)) {
      sanitized = sanitized.split(home).join('~')
    }

    if (sanitized.length > maxLength) {
      return `${sanitized.slice(0, maxLength)}...[TRUNCATED ${sanitized.length - maxLength} chars]`
    }
    return sanitized
  }

  private async ensureLogDir(): Promise<void> {
    await fs.mkdir(this.getLogDir(), { recursive: true })
  }

  private getConfigDir(): string {
    return process.env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy')
  }

  private formatConsoleArgs(args: unknown[]): string {
    return this.sanitizeString(args.map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(this.sanitizeValue(arg))
      } catch {
        return String(arg)
      }
    }).join(' '))
  }

  private formatUnknownReason(reason: unknown): string {
    if (reason instanceof Error) return reason.message || reason.name
    if (typeof reason === 'string') return this.sanitizeString(reason)
    try {
      return this.sanitizeString(JSON.stringify(this.sanitizeValue(reason)))
    } catch {
      return this.sanitizeString(String(reason))
    }
  }

  private writeProcessFailureToStderr(label: string, reason: unknown): void {
    if (reason instanceof Error && reason.stack) {
      process.stderr.write(`[Server] ${label}:\n${reason.stack}\n`)
      return
    }
    const summary = reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : this.formatUnknownReason(reason)
    process.stderr.write(`[Server] ${label}: ${summary}\n`)
  }

  private formatRuntimeLogEntry(event: DiagnosticEvent): string {
    const lines = [
      `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}`,
      `summary: ${event.summary}`,
    ]
    if (event.details !== undefined) {
      lines.push('details:')
      lines.push(JSON.stringify(event.details, null, 2))
    }
    return `${lines.join('\n')}\n\n`
  }

  private getClientIncidentSummary(type: string): string {
    switch (type) {
      case 'client_window_error':
      case 'client_unhandled_rejection':
      case 'client_react_error_boundary':
        return 'A desktop application issue was recorded.'
      case 'client_api_request_failed':
        return 'A desktop service request issue was recorded.'
      default:
        return 'A desktop application issue was recorded.'
    }
  }

  private async enforceRetention(): Promise<void> {
    const dir = this.getLogDir()
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = await this.listFiles(dir)

    for (const file of files) {
      if (file.mtimeMs < cutoff) {
        await fs.rm(file.path, { force: true })
      }
    }

    const remaining = (await this.listFiles(dir)).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = remaining.reduce((sum, file) => sum + file.size, 0)
    for (const file of remaining) {
      if (total <= MAX_BYTES) break
      await fs.rm(file.path, { force: true })
      total -= file.size
    }
  }

  private async listFiles(dir: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const results: Array<{ path: string; size: number; mtimeMs: number }> = []
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }

    for (const entry of entries) {
      const filePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...await this.listFiles(filePath))
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(filePath)
      results.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs })
    }
    return results
  }

}

export const diagnosticsService = new DiagnosticsService()
