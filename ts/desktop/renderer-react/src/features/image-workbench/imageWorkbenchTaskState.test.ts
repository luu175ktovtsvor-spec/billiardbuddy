import { expect, test } from 'bun:test'
import { imageWorkbenchTaskReducer, initialImageWorkbenchTaskState } from './imageWorkbenchTaskState'

test('任务状态从开始、轮询到结束,保留进度但清理运行句柄', () => {
  let state = imageWorkbenchTaskReducer(initialImageWorkbenchTaskState, { type: 'begin', stage: '正在生成图片…' })
  expect(state).toMatchObject({ busy: true, progress: 0, stage: '正在生成图片…', pane: 'canvas', lastError: '' })
  state = imageWorkbenchTaskReducer(state, { type: 'job-started', jobId: 'job-1' })
  state = imageWorkbenchTaskReducer(state, { type: 'progress', progress: 42, stage: '正在处理…' })
  state = imageWorkbenchTaskReducer(state, { type: 'stage', stage: '正在补充候选…' })
  expect(state.progress).toBe(42)
  state = imageWorkbenchTaskReducer(state, { type: 'finish' })
  expect(state).toMatchObject({ busy: false, progress: 42, stage: '', activeJobId: null })
})

test('失败动作可重试,下一次开始会清理旧错误', () => {
  let state = imageWorkbenchTaskReducer(initialImageWorkbenchTaskState, { type: 'failed', message: '生成失败', action: 'generate' })
  expect(state).toMatchObject({ lastError: '生成失败', lastFailedAction: 'generate' })
  state = imageWorkbenchTaskReducer(state, { type: 'begin', stage: '重新生成…' })
  expect(state).toMatchObject({ lastError: '', lastFailedAction: null, busy: true })
})

test('取消先展示已取消,finally 收尾不清除错误反馈', () => {
  let state = imageWorkbenchTaskReducer(initialImageWorkbenchTaskState, { type: 'begin', stage: '正在生成图片…' })
  state = imageWorkbenchTaskReducer(state, { type: 'job-started', jobId: 'job-1' })
  state = imageWorkbenchTaskReducer(state, { type: 'cancel-requested' })
  expect(state).toMatchObject({ busy: false, stage: '已请求取消', lastError: '已取消', activeJobId: 'job-1' })
  state = imageWorkbenchTaskReducer(state, { type: 'finish' })
  expect(state).toMatchObject({ busy: false, stage: '', lastError: '已取消', activeJobId: null })
})

test('本地导出只切换忙碌状态,不会清除此前的重试上下文', () => {
  const failed = imageWorkbenchTaskReducer(initialImageWorkbenchTaskState, { type: 'failed', message: '修改失败', action: 'edit' })
  const exporting = imageWorkbenchTaskReducer(failed, { type: 'begin-local', stage: '正在准备 PNG…' })
  expect(exporting).toMatchObject({ busy: true, stage: '正在准备 PNG…', lastError: '修改失败', lastFailedAction: 'edit' })
})
