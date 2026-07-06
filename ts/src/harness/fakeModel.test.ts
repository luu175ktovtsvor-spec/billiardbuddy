import { test, expect } from 'bun:test'
import { scriptedModel } from './fakeModel'
import { userText } from '../types/message'

test('scriptedModel 按序返回步骤并记录 system/messages/tools', async () => {
  const model = scriptedModel([{ kind: 'final', text: '好' }])
  const step = await model.step({ system: 'SYS-PROMPT', messages: [userText('hi')], tools: [] })
  expect(step).toEqual({ kind: 'final', text: '好' })
  expect(model.received[0]!.system).toBe('SYS-PROMPT')
  expect(model.received[0]!.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
})

test('步骤用尽即抛', async () => {
  const model = scriptedModel([{ kind: 'final', text: 'x' }])
  await model.step({ messages: [], tools: [] })
  await expect(model.step({ messages: [], tools: [] })).rejects.toThrow('步骤用尽')
})
