import { describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('./client', () => ({
  productApi: client,
}))

import { productRecentProjectsApi } from './projects'

describe('productRecentProjectsApi', () => {
  it('uses the product-owned recent-project route', () => {
    productRecentProjectsApi.list(20)

    expect(client.get).toHaveBeenCalledWith('/api/product/projects/recent?limit=20')
  })

  it('does not fall back to the Core session route', () => {
    productRecentProjectsApi.list()

    expect(client.get).toHaveBeenLastCalledWith('/api/product/projects/recent')
  })
})
