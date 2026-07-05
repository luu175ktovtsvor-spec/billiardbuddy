import type { AssistantStep, Model, ModelStepInput } from '../types/model'

/** 脚本化 fake model:按序返回预设步骤,并记录每次收到的 {messages,tools}(供断言 <env> 已注入)。真模型 = W6。 */
export function scriptedModel(steps: AssistantStep[]): Model & { received: ModelStepInput[] } {
  let i = 0
  const received: ModelStepInput[] = []
  return {
    received,
    async step(input) {
      received.push(input)
      const s = steps[i++]
      if (!s) throw new Error(`scriptedModel: 步骤用尽(已用 ${i - 1} 步)`)
      return s
    },
  }
}
