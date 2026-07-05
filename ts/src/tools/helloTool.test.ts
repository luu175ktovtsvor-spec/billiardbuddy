import { expect, test } from 'bun:test'
import { helloTool } from './helloTool'

test('helloTool has a stable name and greets the given name', async () => {
  expect(helloTool.name).toBe('hello')
  const out = await helloTool.execute({ name: 'world' })
  expect(out).toBe('Hello, world!')
})
