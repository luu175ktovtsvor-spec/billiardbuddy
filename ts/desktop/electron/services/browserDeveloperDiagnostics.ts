function httpDiagnosticUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

const SENSITIVE_PATH_LABEL = /^(?:auth|authorization|callback|invite|invitation|magic|oauth|password|reset|secret|token|verify|verification)$/i

function decodedPathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function opaquePathCredential(value: string): boolean {
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return true
  if (/^[0-9a-f]{24,}$/i.test(value)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return true
  return value.length >= 32
    && /^[A-Za-z0-9._~-]+$/.test(value)
    && /[A-Za-z]/.test(value)
    && /[0-9]/.test(value)
}

function sanitizedPathname(pathname: string): string {
  let redactNext = false
  return pathname.split('/').map(segment => {
    const decoded = decodedPathSegment(segment)
    if (redactNext && decoded.length > 0) {
      redactNext = false
      return '[redacted]'
    }
    const keyed = decoded.match(/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)[:=](.+)$/i)
    if (keyed) return `${keyed[1]}=[redacted]`
    if (SENSITIVE_PATH_LABEL.test(decoded)) {
      redactNext = true
      return segment
    }
    return opaquePathCredential(decoded) ? '[redacted]' : segment
  }).join('/')
}

/** Removes credentials, path tokens, query parameters and fragments before a URL leaves Main. */
export function sanitizeBrowserDiagnosticUrl(value: unknown): string | null {
  const url = httpDiagnosticUrl(value)
  if (!url) return null
  const sanitized = `${url.origin}${sanitizedPathname(url.pathname)}`
  return sanitized.length <= 2_048 ? sanitized : `${url.origin}/`
}

/** A defense-in-depth projection for bounded console and network diagnostics. */
export function redactBrowserDiagnosticText(value: unknown): string {
  if (typeof value !== 'string') return ''
  const withoutUrls = value.replace(/https?:\/\/[^\s"'<>]+/gi, candidate =>
    sanitizeBrowserDiagnosticUrl(candidate) ?? '[invalid-url]')
  return withoutUrls
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .slice(0, 1_000)
}
