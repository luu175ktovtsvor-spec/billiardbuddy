import { test, expect } from 'bun:test'
import { withStreamIdleTimeout } from './streamIdleTimeout'

function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const dec = new TextDecoder()
  const reader = stream.getReader()
  let out = ''
  return (async () => {
    while (true) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value) }
    return out
  })()
}

test('活跃流:数据透传', async () => {
  const enc = new TextEncoder()
  const upstream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode('a')); c.enqueue(enc.encode('b')); c.close() },
  })
  expect(await drain(withStreamIdleTimeout(upstream, 1000))).toBe('ab')
})

test('空闲超时:抛错', async () => {
  const upstream = new ReadableStream<Uint8Array>({ start() { /* 永不 enqueue、永不 close */ } })
  await expect(drain(withStreamIdleTimeout(upstream, 30))).rejects.toThrow('idle timeout')
})
