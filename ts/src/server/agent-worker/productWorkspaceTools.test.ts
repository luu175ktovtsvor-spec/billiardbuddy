import { describe, expect, test } from 'bun:test'
import {
  isProductAllowedResolvedWebAddress,
  readProductNativeSearchStream,
  resolveProductPublicWebTarget,
} from './productWorkspaceTools.js'

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('Product native Web Search stream', () => {
  test('preserves server tool, result, usage, stop reason, and keep-alive framing', async () => {
    const response = streamResponse([
      ': keep-alive\r',
      '\n\r\nevent: content_block_start\r\ndata: {"type":"content_block_start","content_block":{"type":"server_tool_use","name":"web_search"}}\r\n\r\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"web_search_tool_result","url":"https://example.test"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])

    const transcript = await readProductNativeSearchStream(response)

    expect(transcript.events).toHaveLength(4)
    expect(transcript.events[0]).toMatchObject({
      event: 'content_block_start',
      data: { content_block: { type: 'server_tool_use', name: 'web_search' } },
    })
    expect(transcript.events[1]).toMatchObject({ data: { delta: { type: 'web_search_tool_result' } } })
    expect(transcript.stop_reason).toBe('end_turn')
    expect(transcript.usage).toEqual({ output_tokens: 9 })
  })

  test('fails closed when the upstream stream ends without a terminal event', async () => {
    const response = streamResponse([
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"server_tool_use"}}\n\n',
    ])
    await expect(readProductNativeSearchStream(response)).rejects.toThrow('PRODUCT_WEB_SEARCH_STREAM_INTERRUPTED')
  })
})

describe('Product public Web Fetch target', () => {
  test('rejects local, private, mapped, documentation, and mixed DNS targets', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.1.1', '192.168.1.2', '198.51.100.3', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
      expect(isProductAllowedResolvedWebAddress(address)).toBeFalse()
    }
    expect(isProductAllowedResolvedWebAddress('93.184.216.34')).toBeTrue()
    expect(isProductAllowedResolvedWebAddress('2606:4700:4700::1111')).toBeTrue()

    await expect(resolveProductPublicWebTarget('https://example.test', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('PRODUCT_WEB_TARGET_BLOCKED')

    await expect(resolveProductPublicWebTarget('https://198.18.0.1')).rejects.toThrow('PRODUCT_WEB_TARGET_BLOCKED')
    await expect(resolveProductPublicWebTarget('https://example.test', async () => [
      { address: '198.18.0.204', family: 4 },
    ])).resolves.toMatchObject({ hostname: 'example.test', address: '198.18.0.204' })
  })

  test('pins a validated public address while preserving the TLS hostname and URL', async () => {
    const target = await resolveProductPublicWebTarget('https://example.test:8443/path?q=1', async hostname => {
      expect(hostname).toBe('example.test')
      return [{ address: '93.184.216.34', family: 4 }]
    })
    expect(target).toMatchObject({
      hostname: 'example.test',
      address: '93.184.216.34',
      family: 4,
    })
    expect(target.url.toString()).toBe('https://example.test:8443/path?q=1')
  })
})
