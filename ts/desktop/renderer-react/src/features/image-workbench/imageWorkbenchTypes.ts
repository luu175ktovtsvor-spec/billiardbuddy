// 生图工作台共享常量与类型：场景模板、画布对象标记和蒙版绘制状态。

import type { FabricObject } from 'fabric'
import type { ImageWorkbenchImageLayer } from '../../api/studio'

export const RATIOS: { id: string; label: string }[] = [
  { id: '9:16', label: '竖屏' },
  { id: '1:1', label: '方图' },
  { id: '3:4', label: '海报' },
  { id: '16:9', label: '横版' },
  { id: '2:5', label: '易拉宝' },
]

export const COUNTS = [1, 2, 3, 4]

export const POSTER_TYPES: Array<{ id: string; label: string; prompt: string }> = [
  { id: 'custom_poster', label: '自由创作', prompt: '' },
  { id: 'opening_anniversary', label: '开业/焕新', prompt: '做一张开业或门店焕新海报' },
  { id: 'weekend_bundle', label: '优惠/团购', prompt: '做一张优惠或团购海报' },
  { id: 'membership_recharge', label: '会员/充值', prompt: '做一张会员或充值活动海报' },
  { id: 'tournament_signup', label: '比赛/活动', prompt: '做一张比赛或活动海报' },
  { id: 'recruitment_role', label: '招聘/岗位', prompt: '做一张招聘或岗位介绍海报' },
  { id: 'daily_social', label: '日常/社媒', prompt: '做一张日常分享或社媒海报' },
]

export type MaskMode = 'select' | 'rect' | 'brush'
export type MaskItem =
  | { type: 'rect'; x: number; y: number; width: number; height: number }
  | { type: 'brush'; points: Array<{ x: number; y: number }>; size: number }
export type WorkbenchAction = 'generate' | 'edit' | 'inpaint' | 'upscale'

export type WorkbenchObject = FabricObject & {
  workbenchLayerId?: string
  imageLayerId?: string
  imageLayerType?: ImageWorkbenchImageLayer['type']
  workbenchLayerUrl?: string
  maskRole?: boolean
  backgroundRole?: boolean
}

export interface DrawingState {
  mode: Extract<MaskMode, 'rect' | 'brush'>
  start: { x: number; y: number }
  points: Array<{ x: number; y: number }>
  object: WorkbenchObject
}
