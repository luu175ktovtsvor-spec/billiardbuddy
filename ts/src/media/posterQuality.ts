import { readFile } from 'node:fs/promises'
import { detectImageFormat, getImageDimensions, isVisionSupported } from '../tools/imageRead'
import type { ImageWorkbenchTextLayer } from '../../shared/contracts/image-workbench'

export interface PosterHardGateInput {
  path?: string
  width: number
  height: number
  textLayers?: ImageWorkbenchTextLayer[]
  requiredCopy?: string[]
  logoPresent?: boolean
  qrcodePresent?: boolean
}

export interface PosterHardGateDecision {
  state: 'passed' | 'blocked' | 'unchecked'
  passed: boolean
  warnings: string[]
}

export async function inspectPosterHardGate(input: PosterHardGateInput): Promise<PosterHardGateDecision> {
  const warnings: string[] = []
  if (!input.path) return { state: 'unchecked', passed: false, warnings: ['无法读取候选图片文件。'] }
  try {
    const bytes = await readFile(input.path)
    const format = detectImageFormat(bytes)
    const dimensions = format && isVisionSupported(format) ? getImageDimensions(bytes, format) : null
    if (!format || !dimensions) warnings.push('候选不是可读取的真实栅格图片。')
    if (dimensions && (dimensions.width !== input.width || dimensions.height !== input.height)) {
      warnings.push(`候选尺寸为 ${dimensions.width}x${dimensions.height}，不是目标 ${input.width}x${input.height}。`)
    }
    const layers = input.textLayers ?? []
    const text = layers.map(layer => layer.text).join('')
    for (const copy of input.requiredCopy ?? []) if (copy && !text.includes(copy)) warnings.push(`受控文字层缺少：${copy}`)
    if (input.logoPresent === false) warnings.push('Logo 尚未加入确定性图层。')
    if (input.qrcodePresent === false) warnings.push('二维码尚未加入确定性图层。')
    return { state: warnings.length ? 'blocked' : 'passed', passed: warnings.length === 0, warnings }
  } catch {
    return { state: 'unchecked', passed: false, warnings: ['候选图片无法读取，未通过海报硬闸。'] }
  }
}
