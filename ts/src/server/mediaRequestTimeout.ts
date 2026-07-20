export function isLongMediaRequestPath(pathname: string): boolean {
  if (pathname === '/api/media' || pathname.startsWith('/api/media/')) return true
  return /^\/api\/product\/tasks\/[^/]+\/media(?:\/|$)/.test(pathname)
}
