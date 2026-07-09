// 资产管理器共享类型:瘦安装包 + 大块头资产(ffmpeg/转写权重/中文字体)首启后
// 从静态资源服务器后台静默下载(manifest + SHA-256 校验 + Range 断点续传)。

/** 资产适用平台;'all' = 平台无关(如字体、模型权重)。 */
export type AssetPlatform = 'darwin-arm64' | 'win32-x64' | 'all'

/** Tier1 = 首启自动串行下载;Tier2 = 默认不下,功能门按需触发。 */
export type AssetTier = 1 | 2

/** 远端清单里的单个资产条目。 */
export interface AssetSpec {
  id: string
  platform: AssetPlatform
  tier: AssetTier
  /** 下载体(zip 或裸文件)字节数,用于进度与断点判断。 */
  size: number
  /** 下载体的 SHA-256(hex 小写),校验不过删掉重下。 */
  sha256: string
  url: string
  /** 'zip' = 下载后用系统 unzip/tar 解包;缺省/'none' = 单文件直接落位。 */
  unpack?: 'zip' | 'none'
  /** 资产主文件相对路径(相对 <stateRoot>/assets/<id>/),就绪后作为对外 path。 */
  dest: string
}

export interface AssetManifest {
  version: string
  assets: AssetSpec[]
}

export type AssetStatus = 'pending' | 'downloading' | 'verifying' | 'ready' | 'failed'

/** 单资产持久化状态(state.json)。 */
export interface AssetRecord {
  id: string
  tier: AssetTier
  status: AssetStatus
  /** 0-100;ready 恒为 100。 */
  progress: number
  /** 清单声明的下载体大小。 */
  size: number
  /** 清单声明的下载体 SHA-256;变了视为新版本、重下。 */
  sha256: string
  /** ready 时主文件绝对路径。 */
  path?: string
  /** ready 时主文件实际字节数(启动快速校验用:存在 + 大小对,不必全量 hash)。 */
  fileSize?: number
  error?: string
  attempts: number
  /** failed 后计划的下次自动重试时刻(epoch ms)。 */
  nextRetryAt?: number
  updatedAt: number
}

export interface AssetsState {
  manifestVersion: string
  assets: Record<string, AssetRecord>
  updatedAt: number
}

/** 功能门返回:就绪给路径;没就绪给进度;失败说明是否已排了重试。 */
export type EnsureAssetResult =
  | { status: 'ready'; path: string }
  | { status: 'downloading'; progress: number }
  | { status: 'failed'; retryScheduled: boolean }

/** WS 事件(/agent/ws 上广播,前端"正在准备组件 x%"UI 用)。 */
export interface AssetProgressEvent {
  type: 'asset_progress'
  id: string
  status: AssetStatus
  progress: number
  tier: AssetTier
  path?: string
  error?: string
  ts: number
}
