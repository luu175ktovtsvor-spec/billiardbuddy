import { expect, test } from 'bun:test'
import { finishWhenWorkspaceSelected } from './OnboardingPage'

test('取消原生文件夹选择时停留在工作区步骤', async () => {
  let finished = false
  const selected = await finishWhenWorkspaceSelected(async () => null, () => { finished = true })

  expect(selected).toBe(false)
  expect(finished).toBe(false)
})

test('选中原生文件夹后才完成引导', async () => {
  let finished = false
  const selected = await finishWhenWorkspaceSelected(async () => '/Users/demo/project', () => { finished = true })

  expect(selected).toBe(true)
  expect(finished).toBe(true)
})
