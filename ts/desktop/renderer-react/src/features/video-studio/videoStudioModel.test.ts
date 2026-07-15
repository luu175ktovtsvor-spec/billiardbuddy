import { expect, test } from 'bun:test'
import { friendlyVideoText, initialVideoProjectInput, videoBriefInput } from './videoStudioModel'

test('视频系统状态在进入界面前转换为普通用户语言', () => {
  const message = friendlyVideoText('Scene 2 的 ASR 在 revision 4 失败；请选择其他 Take 或修改 CTA')

  expect(message).toBe('片段 2 的 语音识别 在 版本 4 失败；请选择其他 口播素材 或修改 行动提示')
  expect(message).not.toMatch(/Scene|ASR|revision|Take|CTA/)
})

test('新建视频项目不在分析前强制片种和内容类型', () => {
  const input = initialVideoProjectInput({
    goalText: '  把这些素材剪成门店宣传片  ',
    paths: ['/workspace/a.mp4'],
    ratio: '9:16',
    durationSec: 30,
    conversationId: 'c1',
    workspaceRoot: '/workspace',
  })

  expect(input).toMatchObject({ name: '把这些素材剪成门店宣传片', user_request: '把这些素材剪成门店宣传片' })
  expect('goal' in input).toBe(false)
  expect('content_type' in input).toBe(false)
})

test('首次理解让后端推断策略，用户纠偏时才传显式值', () => {
  const base = {
    baseRevision: 2,
    goalText: '展示现场氛围',
    contentType: 'event_highlight' as const,
    view: 'talking' as const,
    ratio: '9:16' as const,
    durationSec: 30,
    exactCopyText: '七月开赛\n扫码报名',
  }
  const inferred = videoBriefInput({ ...base, inferStrategy: true })
  const corrected = videoBriefInput(base)

  expect('preferred_view' in inferred).toBe(false)
  expect('content_type' in inferred).toBe(false)
  expect(corrected).toMatchObject({ preferred_view: 'talking', content_type: 'event_highlight', exact_copy: ['七月开赛', '扫码报名'] })
})
