import { StringDecoder } from 'node:string_decoder'

const OSC_SEQUENCE = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g
const STRING_SEQUENCE = /\x1B[P^_X][\s\S]*?\x1B\\/g
const CSI_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const C1_CSI_SEQUENCE = /\x9B[0-?]*[ -/]*[@-~]/g
const CHARSET_SEQUENCE = /\x1B[()#%*+\-./][0-~]/g
const TWO_CHAR_ESCAPE = /\x1B[@-Z\\-_]/g
const CONTROL_CHARS_EXCEPT_TAB_LF = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g

export function stripAnsiControlSequences(value: string): string {
  if (!value) return ''
  return value
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(C1_CSI_SEQUENCE, '')
    .replace(CHARSET_SEQUENCE, '')
    .replace(TWO_CHAR_ESCAPE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROL_CHARS_EXCEPT_TAB_LF, '')
}

export class StreamingOutputSanitizer {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  push(chunk: Buffer | string): string {
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk)
    if (!text) return ''
    const combined = this.pending + text
    const pendingLength = trailingIncompleteAnsiLength(combined)
    this.pending = pendingLength > 0 ? combined.slice(combined.length - pendingLength) : ''
    const ready = pendingLength > 0 ? combined.slice(0, combined.length - pendingLength) : combined
    return stripAnsiControlSequences(ready)
  }

  flush(): string {
    const decoded = this.decoder.end()
    const combined = this.pending + decoded
    this.pending = ''
    if (!combined) return ''
    const pendingLength = trailingIncompleteAnsiLength(combined)
    const ready = pendingLength > 0 ? combined.slice(0, combined.length - pendingLength) : combined
    return stripAnsiControlSequences(ready)
  }
}

function trailingIncompleteAnsiLength(value: string): number {
  const escStart = value.lastIndexOf('\x1B')
  const c1Start = value.lastIndexOf('\x9B')
  const start = Math.max(escStart, c1Start)
  if (start < 0) return 0
  const tail = value.slice(start)
  if (!isIncompleteAnsiPrefix(tail)) return 0
  return tail.length
}

function isIncompleteAnsiPrefix(tail: string): boolean {
  if (tail === '\x1B' || tail === '\x9B') return true
  if (tail.startsWith('\x9B')) return !/^\x9B[0-?]*[ -/]*[@-~]/.test(tail)
  if (!tail.startsWith('\x1B')) return false

  const marker = tail[1]
  if (!marker) return true
  if (marker === '[') return !/^\x1B\[[0-?]*[ -/]*[@-~]/.test(tail)
  if (marker === ']') return !/^\x1B\][\s\S]*?(?:\x07|\x1B\\)/.test(tail)
  if (marker === 'P' || marker === '^' || marker === '_' || marker === 'X') {
    return !/^\x1B[P^_X][\s\S]*?\x1B\\/.test(tail)
  }
  if (/^[()#%*+\-./]$/.test(marker)) return tail.length < 3
  return false
}
