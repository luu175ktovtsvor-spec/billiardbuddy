export function isLongMediaRequestPath(pathname: string): boolean {
  if (pathname === '/api/media' || pathname.startsWith('/api/media/')) return true
  if (pathname === '/api/images' || pathname.startsWith('/api/images/')) return true
  if (pathname === '/api/videos' || pathname.startsWith('/api/videos/')) return true
  return false
}
