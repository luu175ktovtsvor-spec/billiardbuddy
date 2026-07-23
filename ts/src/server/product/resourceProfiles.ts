import type { ProductResourceBenchmarkEvidence, ProductResourceByteBudget, ProductResourceHardwareIdentity, ProductResourceKey, ProductResourceProfile, ProductResourceProfileLimit } from '../../../shared/product/resourceScheduler.js'

const HOUR = 60 * 60 * 1000
const baselineBytes: ProductResourceByteBudget = { memory: 512 * 1024 * 1024, input: 64 * 1024 * 1024, temp: 256 * 1024 * 1024, output: 128 * 1024 * 1024 }

function limit(maxActive = 1): ProductResourceProfileLimit {
  return { max_active: maxActive, max_queued: 32, max_active_per_owner: 1, max_queued_per_owner: 8, bytes: { ...baselineBytes } }
}

/** Safe, shipped baseline.  Expired device measurements always fall back here. */
export function conservativeDesktopResourceProfile(now = new Date(), platform = process.platform, toolchain = process.version, hardware: ProductResourceHardwareIdentity = defaultHardwareIdentity()): ProductResourceProfile {
  const limits: Partial<Record<ProductResourceKey, ProductResourceProfileLimit>> = {}
  for (const key of ['agent.worker', 'agent.turn', 'filesystem.write.workspace', 'filesystem.write.external', 'content.inspect', 'content.thumbnail', 'storage.attachment-temp'] as const) limits[key] = limit()
  return { scope: 'desktop-host', revision: 'conservative-desktop-v1', expires_at: new Date(now.getTime() + 365 * 24 * HOUR).toISOString(), platform, toolchain, hardware, limits }
}

export function defaultHardwareIdentity(): ProductResourceHardwareIdentity {
  return { machine_class: process.arch, logical_cpu_count: 1, memory_bytes: 0 }
}

export type DeviceBenchmarkReceipt = {
  profile: ProductResourceProfile
  hardware: ProductResourceHardwareIdentity
  benchmark: ProductResourceBenchmarkEvidence
  benchmarked_at: string
  status: 'baseline' | 'promoted' | 'degraded'
  reason?: 'BENCHMARK_FAILED' | 'PROFILE_EXPIRED' | 'TOOLCHAIN_MISMATCH' | 'PLATFORM_MISMATCH'
}

/** Keeps baseline availability independent from optional device measurement. */
export class DesktopResourceProfiles {
  private device?: DeviceBenchmarkReceipt

  constructor(
    private readonly baseline = conservativeDesktopResourceProfile(),
    private readonly now: () => Date = () => new Date(),
    private readonly platform = process.platform,
    private readonly toolchain = process.version,
  ) {}

  current(): DeviceBenchmarkReceipt {
    const device = this.device
    if (device && device.status === 'promoted' && this.compatible(device.profile)) return device
    return { profile: this.baseline, hardware: device?.hardware ?? this.baseline.hardware, benchmark: benchmarkEvidence(device?.profile ?? this.baseline), benchmarked_at: device?.benchmarked_at ?? this.now().toISOString(), status: device ? 'degraded' : 'baseline', ...(device ? { reason: device.status === 'degraded' ? device.reason : this.invalidReason(device.profile) } : {}) }
  }

  promote(profile: ProductResourceProfile): DeviceBenchmarkReceipt {
    if (!this.compatible(profile)) {
      this.device = { profile, hardware: profile.hardware, benchmark: benchmarkEvidence(profile), benchmarked_at: this.now().toISOString(), status: 'degraded', reason: this.invalidReason(profile) }
      return this.current()
    }
    this.device = { profile, hardware: profile.hardware, benchmark: benchmarkEvidence(profile), benchmarked_at: this.now().toISOString(), status: 'promoted' }
    return this.device
  }

  benchmarkFailed(profile = this.baseline): DeviceBenchmarkReceipt {
    this.device = { profile, hardware: profile.hardware, benchmark: benchmarkEvidence(profile), benchmarked_at: this.now().toISOString(), status: 'degraded', reason: 'BENCHMARK_FAILED' }
    return this.current()
  }

  private compatible(profile: ProductResourceProfile): boolean {
    return profile.scope === 'desktop-host' && profile.platform === this.platform && profile.toolchain === this.toolchain && validHardware(profile.hardware) && Date.parse(profile.expires_at) > this.now().getTime() && Object.values(profile.limits).every(value => value && validLimit(value))
  }

  private invalidReason(profile: ProductResourceProfile): NonNullable<DeviceBenchmarkReceipt['reason']> {
    if (profile.platform !== this.platform) return 'PLATFORM_MISMATCH'
    if (profile.toolchain !== this.toolchain) return 'TOOLCHAIN_MISMATCH'
    if (Object.values(profile.limits).some(value => !value || !validLimit(value))) return 'BENCHMARK_FAILED'
    return 'PROFILE_EXPIRED'
  }
}

function validLimit(value: ProductResourceProfileLimit): boolean {
  const integers = [value.max_active, value.max_queued, value.max_active_per_owner, value.max_queued_per_owner]
  const byteCeiling = 32 * 1024 * 1024 * 1024
  return integers.every(number => Number.isSafeInteger(number) && number >= 0)
    && value.max_active <= 8 && value.max_queued <= 128
    && value.max_active_per_owner <= value.max_active && value.max_queued_per_owner <= value.max_queued
    && Object.values(value.bytes).every(number => Number.isSafeInteger(number) && number >= 0 && number <= byteCeiling)
}

function validHardware(value: ProductResourceHardwareIdentity): boolean {
  return typeof value.machine_class === 'string' && value.machine_class.length > 0 && value.machine_class.length <= 64
    && Number.isSafeInteger(value.logical_cpu_count) && value.logical_cpu_count >= 1 && value.logical_cpu_count <= 256
    && Number.isSafeInteger(value.memory_bytes) && value.memory_bytes >= 0 && value.memory_bytes <= 32 * 1024 * 1024 * 1024 * 1024
}

function benchmarkEvidence(profile: ProductResourceProfile): ProductResourceBenchmarkEvidence {
  return { hardware: profile.hardware, platform: profile.platform, toolchain: profile.toolchain, profile_revision: profile.revision, expires_at: profile.expires_at }
}
