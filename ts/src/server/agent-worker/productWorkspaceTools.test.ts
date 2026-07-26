import { describe, expect, test } from 'bun:test'
import { readProductNativeSearchStream } from './productWorkspaceTools.js'

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
