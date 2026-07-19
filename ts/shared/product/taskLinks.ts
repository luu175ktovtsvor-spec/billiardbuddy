export const PRODUCT_TASK_LINK_SCHEME = 'billiardbuddy'
export const PRODUCT_TASK_WINDOW_QUERY_KEY = 'task'

const PRODUCT_TASK_ID_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/

export function normalizeProductTaskId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const taskId = value.trim()
  return PRODUCT_TASK_ID_PATTERN.test(taskId) ? taskId : null
}

export function buildProductTaskLink(taskId: string): string | null {
  const normalizedTaskId = normalizeProductTaskId(taskId)
  return normalizedTaskId
    ? `${PRODUCT_TASK_LINK_SCHEME}://task/${encodeURIComponent(normalizedTaskId)}`
    : null
}

export function parseProductTaskLink(value: string): string | null {
  let link: URL
  try {
    link = new URL(value)
  } catch {
    return null
  }

  if (
    link.protocol !== `${PRODUCT_TASK_LINK_SCHEME}:`
    || link.hostname !== 'task'
    || link.username
    || link.password
    || link.port
    || link.search
    || link.hash
  ) {
    return null
  }

  const segments = link.pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null

  try {
    return normalizeProductTaskId(decodeURIComponent(segments[0]!))
  } catch {
    return null
  }
}

export function parseProductTaskWindowSearch(search: string): string | null {
  return normalizeProductTaskId(new URLSearchParams(search).get(PRODUCT_TASK_WINDOW_QUERY_KEY))
}
