import { productApi } from './client'
import type { ProductRecentProjectList } from '../domain/types'

export type { ProductRecentProject } from '../domain/types'

export type ProductRecentProjectsApi = {
  list: (limit?: number) => Promise<ProductRecentProjectList>
}

export const productRecentProjectsApi: ProductRecentProjectsApi = {
  list: (limit) => {
    const query = typeof limit === 'number' ? `?limit=${encodeURIComponent(limit)}` : ''
    return productApi.get<ProductRecentProjectList>(`/api/product/projects/recent${query}`)
  },
}
