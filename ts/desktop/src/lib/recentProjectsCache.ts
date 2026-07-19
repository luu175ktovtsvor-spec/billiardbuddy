import type { ProductRecentProject } from '../product/api/projects'

let cachedProjects: ProductRecentProject[] | null = null
let cacheTimestamp = 0
const CACHE_TTL = 30_000

export function getCachedRecentProjects(): ProductRecentProject[] | null {
  if (!cachedProjects || Date.now() - cacheTimestamp >= CACHE_TTL) return null
  return cachedProjects
}

export function setCachedRecentProjects(projects: ProductRecentProject[]): void {
  cachedProjects = projects
  cacheTimestamp = Date.now()
}

export function invalidateRecentProjectsCache(): void {
  cachedProjects = null
  cacheTimestamp = 0
}
