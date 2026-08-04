export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class UpstreamResponseTooLargeError extends Error {
  constructor() { super('upstream_response_too_large') }
}

export class UpstreamDeadlineExceededError extends Error {
  constructor() { super('upstream_deadline_exceeded') }
}

/** Reads an upstream body by actual bytes, not JavaScript string length. */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')?.trim()
  if (contentLength && /^[0-9]+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new UpstreamResponseTooLargeError()
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > maxBytes) {
        try { await reader.cancel() } catch { /* size limit remains authoritative */ }
        throw new UpstreamResponseTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

/** Per-request deadline with caller cancellation propagation. It leaves no timer alive after the fetch settles. */
export async function fetchWithDeadline(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<Response> {
  if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  const onAbort = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new UpstreamDeadlineExceededError()), timeoutMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof UpstreamDeadlineExceededError) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onAbort)
  }
}

/** Applies the same deadline to connection, headers and bounded body drain. */
export async function fetchBoundedResponseText(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  maxBytes: number,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<{ response: Response; text: string }> {
  if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException('Aborted', 'AbortError')
  const controller = new AbortController()
  const onAbort = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new UpstreamDeadlineExceededError()), timeoutMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal })
    const text = await readBoundedResponseText(response, maxBytes)
    return { response, text }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof UpstreamDeadlineExceededError) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onAbort)
  }
}
