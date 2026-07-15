import { expect, test } from 'bun:test'
import { desktopPickerOptionsSchema, desktopServerConnectionSchema } from './desktop-host'

test('desktop picker options keep old empty calls compatible', () => {
  expect(desktopPickerOptionsSchema.parse({})).toEqual({})
  expect(desktopPickerOptionsSchema.parse({ defaultPath: '/tmp/project' })).toEqual({ defaultPath: '/tmp/project' })
})

test('desktop picker options reject malformed or oversized paths', () => {
  expect(desktopPickerOptionsSchema.safeParse({ defaultPath: 42 }).success).toBe(false)
  expect(desktopPickerOptionsSchema.safeParse({ defaultPath: 'x'.repeat(4097) }).success).toBe(false)
  expect(desktopPickerOptionsSchema.safeParse({ defaultPath: '/tmp', unexpected: true }).success).toBe(false)
})

test('desktop server connection requires an in-memory authentication token', () => {
  expect(desktopServerConnectionSchema.parse({
    baseUrl: 'http://127.0.0.1:8850',
    authToken: 'a'.repeat(32),
  })).toMatchObject({ baseUrl: 'http://127.0.0.1:8850' })
  expect(() => desktopServerConnectionSchema.parse({ baseUrl: 'http://127.0.0.1:8850', authToken: 'short' })).toThrow()
})
