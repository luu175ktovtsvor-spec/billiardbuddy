import { expect, test } from 'bun:test'
import { friendlyVideoText } from './videoStudioModel'

test('视频系统状态在进入界面前转换为普通用户语言', () => {
  const message = friendlyVideoText('Scene 2 的 ASR 在 revision 4 失败；请选择其他 Take 或修改 CTA')

  expect(message).toBe('片段 2 的 语音识别 在 版本 4 失败；请选择其他 口播素材 或修改 行动提示')
  expect(message).not.toMatch(/Scene|ASR|revision|Take|CTA/)
})
