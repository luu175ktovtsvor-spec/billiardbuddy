import { describe, expect, it } from 'bun:test'
import { corsHeaders, resolveCors } from './cors'

describe('corsHeaders', () => {
  it('reflects desktop and loopback browser origins only', () => {
    expect(corsHeaders('file://')['Access-Control-Allow-Origin']).toBe('file://')
    expect(corsHeaders('http://127.0.0.1:1420')['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:1420')
    expect(corsHeaders('http://localhost:3000')['Access-Control-Allow-Origin']).toBe('http://localhost:3000')
    expect(corsHeaders('https://example.com')['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('does not add an origin header to direct local requests', () => {
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

describe('resolveCors', () => {
  it('allows direct requests without an Origin header', async () => {
    const result = await resolveCors(null)

    expect(result).toEqual({
      allowed: true,
      rejected: false,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  })

  it('allows desktop and loopback browser origins', async () => {
    for (const origin of ['file://', 'http://localhost:3000', 'http://127.0.0.1:2024', 'http://127.0.1.1:2024', 'http://[::1]:5173']) {
      const result = await resolveCors(origin)

      expect(result.allowed).toBe(true)
      expect(result.rejected).toBe(false)
      expect(result.headers['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('rejects all non-local browser origins', async () => {
    for (const origin of [
      'https://example.com',
      'http://192.168.0.20:2024',
      'http://10.0.0.5:5173',
      'http://127.example.com:5173',
      'http://127.bad.0.1:5173',
      'http://desktop.localhost.example',
      'https://desktop.localhost.example',
      'desktop://localhost',
      'not-a-url',
    ]) {
      const result = await resolveCors(origin)

      expect(result.allowed).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined()
    }
  })
})
