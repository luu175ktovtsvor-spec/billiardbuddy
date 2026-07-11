import { expect, test } from 'bun:test'
import { upscaleImage, upscaleAvailable, UpscaleUnavailableError } from './imageUpscale'

// 干净 env:无 REALESRGAN_BIN、无资产管理器、PATH 指空目录 → 解析不到超分二进制。
const NO_BIN = { PATH: '/nonexistent-qf-upscale-dir' }

test('upscaleAvailable: 超分二进制缺 → false', () => {
  expect(upscaleAvailable(NO_BIN)).toBe(false)
})

test('upscaleImage: 二进制未就绪 → 抛 UpscaleUnavailableError(优雅降级,不崩、不假装放大成功)', async () => {
  // 反逻辑保护:二进制缺时先抛可识别错(供上层功能门回退"正在准备组件"),不静默失败。
  await expect(upscaleImage('/tmp/whatever.png', { env: NO_BIN })).rejects.toBeInstanceOf(UpscaleUnavailableError)
})
