import { expect, test } from 'bun:test'
import { runHelloLoop, helloModel } from './helloLoop'
import { helloTool } from '../tools/helloTool'
import type { AgentEvent } from '../types/events'

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

test('runHelloLoop emits think -> tool_call -> tool_result -> final', async () => {
  const events = await collect(runHelloLoop({ tools: [helloTool], model: helloModel }))
  expect(events.map(e => e.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'final'])
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toBe('Hello, world!')
})

test('runHelloLoop feeds an unknown tool back as an error, not a crash', async () => {
  const model = (turn: number) =>
    turn === 0
      ? ({ kind: 'tool_call', tool: 'nope', input: { name: 'x' } } as const)
      : ({ kind: 'final', text: 'done' } as const)
  const events = await collect(runHelloLoop({ tools: [helloTool], model }))
  const result = events.find(e => e.type === 'tool_result')
  expect(result && result.type === 'tool_result' && result.output).toContain('unknown tool')
})
