import type { AgentEvent } from '../types/events'
import type { helloTool } from '../tools/helloTool'

type HelloTool = typeof helloTool
export type ModelStep = (
  turn: number,
) =>
  | { kind: 'tool_call'; tool: string; input: { name: string } }
  | { kind: 'final'; text: string }

/** W1 桩循环:证明「想→调工具→回灌结果→再想→出最终」的状态机形状。真循环是 W2。 */
export async function* runHelloLoop(opts: {
  tools: HelloTool[]
  model: ModelStep
  maxTurns?: number
}): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? 4
  for (let turn = 0; turn < maxTurns; turn++) {
    const decision = opts.model(turn)
    if (decision.kind === 'final') {
      yield { type: 'final', text: decision.text }
      return
    }
    yield { type: 'thinking', text: `calling ${decision.tool}` }
    yield { type: 'tool_call', tool: decision.tool, input: decision.input }
    const tool = opts.tools.find(t => t.name === decision.tool)
    if (!tool) {
      // 工具报错不崩循环、错误文本回灌让模型自救(照 loop.py 的做法)。
      yield { type: 'tool_result', tool: decision.tool, output: `error: unknown tool ${decision.tool}` }
      continue
    }
    const output = await tool.execute(decision.input)
    yield { type: 'tool_result', tool: decision.tool, output }
  }
  yield { type: 'final', text: '(max turns reached)' }
}

/** 默认桩模型:第 0 轮调 hello 工具,拿到结果后出最终。 */
export const helloModel: ModelStep = turn =>
  turn === 0
    ? { kind: 'tool_call', tool: 'hello', input: { name: 'world' } }
    : { kind: 'final', text: 'Hello loop complete.' }
