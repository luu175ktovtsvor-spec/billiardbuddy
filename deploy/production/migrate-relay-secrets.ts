import { copyFileSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync, chmodSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { validateDeploymentEnvironment } from '../../gateway/validate-deployment-env.ts'
import { validateRelayDeploymentEnvironment } from '../../relay/validate-deployment-env.ts'
import { validateVideoMediaRelayEnvironment } from '../../video-media-relay/validate-deployment-env.ts'
import { managedModelById } from '../../ts/shared/product/modelCatalog.ts'

type Environment = Record<string, string>

const DEFAULT_GATEWAY_MODEL = 'deepseek-v4-flash'
const RETIRED_GATEWAY_MODEL_ALIASES = new Set(['deepseek-chat', 'deepseek-reasoner'])

export type MigrationPaths = {
  gatewayInput: string
  imageInput: string
  videoInput: string
  gatewayOutput: string
  imageOutput: string
  videoOutput: string
  backupDirectory: string
}

export type MigrationOptions = MigrationPaths & {
  validateOnly?: boolean
  /** Explicit one-time cutover choice: replace stale service resource knobs
   * with the bounded production profile while preserving credentials,
   * provider endpoints, account bindings and storage paths. */
  useSmallProductionProfile?: boolean
  /** Test-only escape hatch. The command-line entrypoint always requires root. */
  enforceRoot?: boolean
}

const GATEWAY_CAPACITY_DEFAULTS: Environment = {
  GW_DB: '/data/usage.db',
  GW_DEEPSEEK_BASE: 'https://api.deepseek.com', GW_MIMO_BASE: 'https://api.xiaomimimo.com/v1',
  GW_QWEN_BASE: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  GW_FUNASR_URL: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  GW_CAPACITY_POLICY_REVISION: 'gateway-small-v1',
  GW_DEEPSEEK_ACCOUNT_REF: 'billiardbuddy-deepseek-production', GW_DEEPSEEK_ACCOUNT_BINDING_REVISION: '1',
  GW_MIMO_ACCOUNT_REF: 'billiardbuddy-mimo-production', GW_MIMO_ACCOUNT_BINDING_REVISION: '1',
  GW_QWEN_ACCOUNT_REF: 'billiardbuddy-qwen-production', GW_QWEN_ACCOUNT_BINDING_REVISION: '1',
  GW_FUNASR_ACCOUNT_REF: 'billiardbuddy-funasr-production', GW_FUNASR_ACCOUNT_BINDING_REVISION: '1',
  GW_BOOTSTRAP_RPM: '30', GW_BOOTSTRAP_QUEUE_MAX: '0', GW_BOOTSTRAP_QUEUE_MAX_WAIT: '0',
  GW_DEEPSEEK_RPM: '120', GW_DEEPSEEK_CONC: '8', GW_DEEPSEEK_USER_CONC: '2', GW_DEEPSEEK_TOKEN_CONC: '4', GW_DEEPSEEK_INFLIGHT_PER_USER: '4', GW_DEEPSEEK_QUEUE_MAX: '24', GW_DEEPSEEK_QUEUE_MAX_WAIT: '5', GW_DEEPSEEK_RESPONSE_TIMEOUT_MS: '120000',
  GW_MIMO_RPM: '60', GW_MIMO_CONC: '8', GW_MIMO_MEDIA_CONC: '5', GW_VISION_CONC: '3', GW_MIMO_USER_CONC: '1', GW_MIMO_TOKEN_CONC: '2', GW_MIMO_INFLIGHT_PER_USER: '1', GW_MIMO_QUEUE_MAX: '16', GW_MIMO_QUEUE_MAX_WAIT: '3', GW_VISION_QUEUE_MAX: '8', GW_VISION_QUEUE_MAX_WAIT_MS: '2000', GW_VISION_PER_CLIENT_CONC: '1', GW_VISION_MAX_INFLIGHT_PER_CLIENT: '1', GW_VISION_PER_REQUEST_CONC: '1', GW_VISION_TIMEOUT_MS: '30000',
  GW_QWEN_RPM: '60', GW_QWEN_CONC: '4', GW_QWEN_USER_CONC: '1', GW_QWEN_TOKEN_CONC: '2', GW_QWEN_INFLIGHT_PER_USER: '2', GW_QWEN_QUEUE_MAX: '12', GW_QWEN_QUEUE_MAX_WAIT: '3', GW_QWEN_RESPONSE_TIMEOUT_MS: '60000',
  GW_TRANSCRIBE_RPM: '6', GW_TRANSCRIBE_CONC: '1', GW_TRANSCRIBE_USER_CONC: '1', GW_TRANSCRIBE_TOKEN_CONC: '1', GW_TRANSCRIBE_INFLIGHT_PER_USER: '1', GW_TRANSCRIBE_QUEUE_MAX: '4', GW_QUEUE_MAX_WAIT: '15', GW_TRANSCRIBE_MAX_BYTES: '67108864', GW_TRANSCRIBE_TIMEOUT_MS: '180000',
  GW_INGRESS_INFLIGHT_BODY_BYTES: '67108864', GW_INGRESS_BODY_READ_TIMEOUT_MS: '30000', GW_SERVER_IDLE_TIMEOUT_SECONDS: '120',
}

const GATEWAY_QUOTA_DEFAULTS: Environment = Object.fromEntries(
  ['TEXT_REASONING', 'VISUAL_EVIDENCE', 'MEDIA_REASONING', 'IMAGE_ADVICE', 'SPEECH_TRANSCRIPTION'].flatMap(capability =>
    ['PRINCIPAL', 'INSTALLATION'].flatMap(scope => {
      const text = capability === 'TEXT_REASONING'
      const installation = scope === 'INSTALLATION'
      return [
        [`GW_QUOTA_${capability}_${scope}_REQUESTS`, text ? '1000000000' : installation ? '2000' : '20000'],
        [`GW_QUOTA_${capability}_${scope}_INPUT_BYTES`, text ? '1000000000000' : installation ? String(50 * 1024 ** 3) : String(500 * 1024 ** 3)],
        [`GW_QUOTA_${capability}_${scope}_OUTPUT_UNITS`, text ? '1000000000000' : installation ? capability === 'SPEECH_TRANSCRIPTION' ? '20000000' : '2000000' : capability === 'SPEECH_TRANSCRIPTION' ? '200000000' : '20000000'],
        [`GW_QUOTA_${capability}_${scope}_TOTAL_TOKENS`, text && installation ? '50000000' : '1000000000000'],
      ]
    }),
  ),
)

const GATEWAY_OPERATIONAL_BINDING_KEYS = new Set([
  'GW_DB', 'GW_DEEPSEEK_BASE', 'GW_MIMO_BASE', 'GW_QWEN_BASE', 'GW_FUNASR_URL',
  'GW_DEEPSEEK_ACCOUNT_REF', 'GW_DEEPSEEK_ACCOUNT_BINDING_REVISION',
  'GW_MIMO_ACCOUNT_REF', 'GW_MIMO_ACCOUNT_BINDING_REVISION',
  'GW_QWEN_ACCOUNT_REF', 'GW_QWEN_ACCOUNT_BINDING_REVISION',
  'GW_FUNASR_ACCOUNT_REF', 'GW_FUNASR_ACCOUNT_BINDING_REVISION',
])

const IMAGE_DEFAULTS: Environment = {
  RELAY_DB: '/data/relay.db', RELAY_BLOB_DIR: '/data/blobs',
  RELAY_TASK_TTL_MS: '604800000', RELAY_UNACKNOWLEDGED_RESULT_TTL_MS: '31536000000',
  RELAY_CAPACITY_POLICY_REVISION: 'relay-image-small-scale-v1',
  RELAY_IMG_CONC: '1', RELAY_IMG_USER_CONC: '1', RELAY_OPENAI_RPM: '12',
  RELAY_SEEDREAM_CONC: '1', RELAY_SEEDREAM_USER_CONC: '1', RELAY_SEEDREAM_RPM: '30',
  RELAY_QUEUE_MAX: '24', RELAY_USER_MAX: '4', RELAY_RETRY_AFTER_SECONDS: '15', RELAY_REQUEST_BODY_TIMEOUT_MS: '30000', RELAY_UPSTREAM_TIMEOUT_MS: '300000',
  RELAY_MAX_BODY_BYTES: '33554432', RELAY_PENDING_INPUT_BYTES_MAX: '67108864', RELAY_ACTIVE_INPUT_BYTES_MAX: '268435456',
  RELAY_IDENTITY_TIMEOUT_MS: '5000', RELAY_IDENTITY_MAX_ACTIVE: '8', RELAY_IDENTITY_QUEUE_MAX: '32', RELAY_IDENTITY_MAX_WAIT_MS: '5000',
  RELAY_RESULT_GLOBAL_CONC: '2', RELAY_RESULT_OWNER_CONC: '1', RELAY_RESULT_MAX_BYTES: '33554432', RELAY_QUOTA_LEDGER_RETENTION_DAYS: '365',
  RELAY_QUOTA_POLICY_REVISION: 'relay-image-quota-small-v1', RELAY_OWNER_DAILY_USD_MINOR_LIMIT: '10000', RELAY_OPENAI_DAILY_USD_MINOR_LIMIT: '100000', RELAY_SEEDREAM_DAILY_USD_MINOR_LIMIT: '100000',
  IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
  IMAGE_RELAY_PUBLIC_BASE: 'https://zzyppz.cn/image-generation',
  IMAGE_RELAY_RESULT_GRANT_TTL_MS: '300000',
  RELAY_OPENAI_BASE: 'https://api.openai.com/v1', RELAY_ARK_BASE: 'https://ark.cn-beijing.volces.com/api/v3',
  RELAY_OPENAI_ACCOUNT_REF: 'billiardbuddy-openai-production', RELAY_OPENAI_ACCOUNT_BINDING_REVISION: '1',
  RELAY_SEEDREAM_ACCOUNT_REF: 'billiardbuddy-seedream-production', RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION: '1',
}

const IMAGE_OPERATIONAL_BINDING_KEYS = new Set([
  'RELAY_DB', 'RELAY_BLOB_DIR',
  'IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE', 'IMAGE_RELAY_PUBLIC_BASE',
  'RELAY_OPENAI_BASE', 'RELAY_ARK_BASE',
  'RELAY_OPENAI_ACCOUNT_REF', 'RELAY_OPENAI_ACCOUNT_BINDING_REVISION',
  'RELAY_SEEDREAM_ACCOUNT_REF', 'RELAY_SEEDREAM_ACCOUNT_BINDING_REVISION',
])

const VIDEO_DEFAULTS: Environment = {
  VIDEO_MEDIA_RELAY_DB: '/data/video-media-relay.db',
  VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
  VIDEO_MEDIA_REGION: 'cn-beijing', VIDEO_MEDIA_OSS_ENDPOINT: 'oss-cn-beijing.aliyuncs.com',
  // Quota is an entitlement/safety ledger, not a concurrency substitute.  A
  // legal semantic-search generation may index 10,000 entries in five batches,
  // so the small-production profile must not reject one valid project merely
  // because its admission gates are deliberately conservative.
  VIDEO_MEDIA_QUOTA_POLICY_REVISION: 'video-media-small-v1', VIDEO_MEDIA_OWNER_DAILY_QUOTA_UNITS: '50000', VIDEO_MEDIA_ACCOUNT_DAILY_QUOTA_UNITS: '1000000', VIDEO_MEDIA_OBJECT_LEASE_QUOTA_UNITS: '32',
  VIDEO_MEDIA_LEASE_TTL_MS: '900000', VIDEO_MEDIA_OUTCOME_UNKNOWN_RETENTION_MS: '259200000', VIDEO_MEDIA_CONTROL_BODY_TIMEOUT_MS: '30000', VIDEO_MEDIA_GATEWAY_INTROSPECTION_TIMEOUT_MS: '10000',
  VIDEO_MEDIA_DASHSCOPE_TIMEOUT_MS: '120000', VIDEO_MEDIA_DASHSCOPE_RESPONSE_MAX_BYTES: '4194304', VIDEO_MEDIA_DASHSCOPE_TRANSCRIPT_MAX_BYTES: '33554432', VIDEO_MEDIA_MULTIPART_THRESHOLD_BYTES: '8388608', VIDEO_MEDIA_MULTIPART_PART_SIZE_BYTES: '16777216',
  VIDEO_MEDIA_CAPACITY_POLICY_REVISION: 'video-media-dashscope-small-v1', VIDEO_MEDIA_DASHSCOPE_QUEUE_MAX: '32', VIDEO_MEDIA_DASHSCOPE_OWNER_QUEUE_MAX: '4', VIDEO_MEDIA_DASHSCOPE_MAX_WAIT_MS: '30000',
  VIDEO_MEDIA_DASHSCOPE_ACCOUNT_MAX_ACTIVE: '4', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_RPM: '120',
  VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF: 'billiardbuddy-dashscope-production', VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION: '1',
  VIDEO_MEDIA_DASHSCOPE_VISUAL_MAX_ACTIVE: '2', VIDEO_MEDIA_DASHSCOPE_VISUAL_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_VISUAL_RPM: '60',
  VIDEO_MEDIA_DASHSCOPE_REASONING_MAX_ACTIVE: '2', VIDEO_MEDIA_DASHSCOPE_REASONING_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_REASONING_RPM: '60',
  VIDEO_MEDIA_DASHSCOPE_ASR_MAX_ACTIVE: '2', VIDEO_MEDIA_DASHSCOPE_ASR_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_ASR_RPM: '30',
  VIDEO_MEDIA_DASHSCOPE_EMBEDDING_MAX_ACTIVE: '4', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_OWNER_MAX_ACTIVE: '1', VIDEO_MEDIA_DASHSCOPE_EMBEDDING_RPM: '240',
  VIDEO_MEDIA_OBJECT_VERIFY_MAX_ACTIVE: '2', VIDEO_MEDIA_OBJECT_VERIFY_OWNER_MAX_ACTIVE: '1',
  VIDEO_MEDIA_OBJECT_VERIFY_QUEUE_MAX: '16', VIDEO_MEDIA_OBJECT_VERIFY_OWNER_QUEUE_MAX: '2',
  VIDEO_MEDIA_OBJECT_VERIFY_MAX_WAIT_MS: '30000', VIDEO_MEDIA_OBJECT_VERIFY_TIMEOUT_MS: '120000',
  VIDEO_MEDIA_IDENTITY_MAX_ACTIVE: '8', VIDEO_MEDIA_IDENTITY_QUEUE_MAX: '32', VIDEO_MEDIA_IDENTITY_MAX_WAIT_MS: '5000',
}

const VIDEO_OPERATIONAL_BINDING_KEYS = new Set([
  'VIDEO_MEDIA_RELAY_DB', 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE',
  'VIDEO_MEDIA_REGION', 'VIDEO_MEDIA_OSS_ENDPOINT',
  'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_REF', 'VIDEO_MEDIA_DASHSCOPE_ACCOUNT_BINDING_REVISION',
])

const REQUIRED_GATEWAY = ['GW_AUTH_SIGNING_KEY', 'GW_ADMIN_TOKEN', 'GW_DEEPSEEK_KEY', 'GW_MIMO_KEY', 'GW_FUNASR_KEY']
const REQUIRED_IMAGE = ['RELAY_OPENAI_KEY', 'RELAY_ARK_KEY']
const REQUIRED_VIDEO = ['VIDEO_MEDIA_DASHSCOPE_API_KEY', 'VIDEO_MEDIA_OSS_BUCKET', 'VIDEO_MEDIA_OSS_ACCESS_KEY_ID', 'VIDEO_MEDIA_OSS_ACCESS_KEY_SECRET']

function fail(message: string): never { throw new Error(`Relay secret migration failed: ${message}`) }

/** Parses literal KEY=VALUE lines only. Values are retained byte-for-byte after the first equals sign. */
export function parseEnvironmentFile(contents: string, label = 'environment'): Environment {
  const environment: Environment = {}
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) fail(`${label} line ${index + 1} is not KEY=VALUE`)
    const [, name, value] = match
    if (value.includes('\0')) fail(`${label} line ${index + 1} contains a NUL byte`)
    if (Object.hasOwn(environment, name)) fail(`${label} defines ${name} more than once`)
    environment[name] = value
  }
  return environment
}

function readEnvironment(path: string, label: string): Environment {
  assertRegularFile(path, `${label} input`)
  assertPrivateFile(path, `${label} input`)
  return parseEnvironmentFile(readFileSync(path, 'utf8'), label)
}

function nonempty(environment: Environment, names: readonly string[], label: string): void {
  for (const name of names) {
    if (!environment[name]?.trim()) fail(`${label} is missing required ${name}`)
  }
}

function token(): string { return randomBytes(32).toString('base64url') }

function withoutLegacyGatewayCoupling(name: string): boolean {
  return name === 'GW_VIDEO_MEDIA_INTROSPECTION_TOKEN'
    || name === 'GW_AGENT_INSTALLATION_DAILY_TOKEN_LIMIT'
    || name.startsWith('GW_RELAY_')
    || name.startsWith('GW_IMAGE_RELAY_')
}

function withoutLegacyImageCoupling(name: string): boolean {
  return name === 'RELAY_TOKEN'
    || name === 'RELAY_PUBLIC_BASE'
    || name.startsWith('RELAY_GATEWAY_')
    || (name.startsWith('RELAY_TASK_') && name !== 'RELAY_TASK_TTL_MS')
    || name.startsWith('RELAY_PROXY_')
}

function selected(environment: Environment, predicate: (name: string) => boolean): Environment {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => predicate(name)))
}

function combine(...layers: Environment[]): Environment {
  return Object.assign({}, ...layers)
}

function migratedGatewayModel(value: string | undefined): string {
  const selected = value?.trim()
  if (!selected || RETIRED_GATEWAY_MODEL_ALIASES.has(selected)) return DEFAULT_GATEWAY_MODEL
  const model = managedModelById(selected)
  if (model?.provider === 'deepseek' && model.text_reasoning_transport === 'responses') return selected
  // Preserve an unknown explicit value so the authoritative Gateway validator
  // rejects it instead of silently selecting a different billable model.
  return selected
}

function assertDistinctTokens(image: string, video: string): void {
  if (image.length < 43 || video.length < 43 || image === video) fail('generated service tokens are invalid')
}

export type MigrationPlan = { gateway: Environment; image: Environment; video: Environment }

/** Build a plan without reading shell syntax, expanding variables, or writing any file. */
export function buildMigrationPlan(
  gatewayInput: Environment,
  relayInput: Environment,
  videoInput: Environment,
  options: Pick<MigrationOptions, 'useSmallProductionProfile'> = {},
): MigrationPlan {
  nonempty(gatewayInput, REQUIRED_GATEWAY, 'gateway.env')
  if (gatewayInput.GW_QWEN_ENABLED?.trim() === '1') nonempty(gatewayInput, ['GW_QWEN_KEY'], 'gateway.env')
  nonempty(relayInput, REQUIRED_IMAGE, 'relay.env')
  nonempty(videoInput, REQUIRED_VIDEO, 'video-media-relay.env')

  const imageToken = token()
  const videoToken = token()
  const resultSigningKey = token()
  assertDistinctTokens(imageToken, videoToken)

  const gateway = combine(
    GATEWAY_CAPACITY_DEFAULTS,
    { GW_QUOTA_POLICY_REVISION: 'bb-agent-daily-token-v1' },
    GATEWAY_QUOTA_DEFAULTS,
    // Defaults fill a missing policy; a valid explicit server value remains
    // authoritative. Migration must never silently reset an operator's
    // capacity, quota, timeout, endpoint, or credential choice.
    selected(gatewayInput, name => name.startsWith('GW_') && !withoutLegacyGatewayCoupling(name)),
    // Only retired aliases are intentionally migrated. Registered explicit
    // models remain authoritative and unknown values fail validation.
    { BB_GATEWAY_MODEL: migratedGatewayModel(gatewayInput.BB_GATEWAY_MODEL) },
    { GW_IMAGE_RELAY_INTROSPECTION_TOKEN: imageToken, GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: videoToken },
  )
  if (options.useSmallProductionProfile) {
    for (const [name, value] of Object.entries({ ...GATEWAY_CAPACITY_DEFAULTS, GW_QUOTA_POLICY_REVISION: 'bb-agent-daily-token-v1', ...GATEWAY_QUOTA_DEFAULTS })) {
      if (!GATEWAY_OPERATIONAL_BINDING_KEYS.has(name)) gateway[name] = value
    }
  }
  const image = combine(
    IMAGE_DEFAULTS,
    selected(relayInput, name => (
      (name.startsWith('RELAY_') && !withoutLegacyImageCoupling(name))
      || (name.startsWith('IMAGE_RELAY_') && !['IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN', 'IMAGE_RELAY_RESULT_SIGNING_KEY'].includes(name))
    )),
    { IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: imageToken, IMAGE_RELAY_RESULT_SIGNING_KEY: resultSigningKey },
  )
  if (options.useSmallProductionProfile) {
    for (const [name, value] of Object.entries(IMAGE_DEFAULTS)) {
      if (!IMAGE_OPERATIONAL_BINDING_KEYS.has(name)) image[name] = value
    }
  }
  const video = combine(
    VIDEO_DEFAULTS,
    selected(videoInput, name => name.startsWith('VIDEO_MEDIA_') && name !== 'VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN'),
    { VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN: videoToken },
  )
  if (options.useSmallProductionProfile) {
    // Historical deployments used Gateway concurrency 1000, Image concurrency
    // 16/queue 2000 and a one-minute Video object lease. They predate the
    // governed service contracts and are not an intentional target profile.
    // Requiring this flag keeps future ordinary migrations operator-driven.
    for (const [name, value] of Object.entries(VIDEO_DEFAULTS)) {
      if (!VIDEO_OPERATIONAL_BINDING_KEYS.has(name)) video[name] = value
    }
  }
  // Generated credentials must never inherit a legacy token, even if a source
  // file already happened to contain a new-looking name.
  gateway.GW_IMAGE_RELAY_INTROSPECTION_TOKEN = imageToken
  gateway.GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN = videoToken
  image.IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN = imageToken
  image.IMAGE_RELAY_RESULT_SIGNING_KEY = resultSigningKey
  video.VIDEO_MEDIA_GATEWAY_INTROSPECTION_TOKEN = videoToken
  return { gateway, image, video }
}

function render(environment: Environment): string {
  return `${Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}=${value}`).join('\n')}\n`
}

function assertRegularFile(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { fail(`${label} does not exist`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
}

function assertPrivateFile(path: string, label: string): void {
  if ((lstatSync(path).mode & 0o077) !== 0) fail(`${label} must not be readable or writable by group or others`)
}

function assertExistingDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { fail(`${label} does not exist`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a directory`)
}

function assertOutputsAbsent(paths: readonly string[]): void {
  for (const path of paths) {
    try { lstatSync(path); fail(`refusing to replace existing output ${basename(path)}`) } catch (error) {
      if (error instanceof Error && error.message.startsWith('Relay secret migration failed:')) throw error
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        fail(`cannot inspect output ${basename(path)}`)
      }
    }
  }
}

function assertPaths(paths: MigrationPaths): void {
  const inputs = [paths.gatewayInput, paths.imageInput, paths.videoInput].map(path => resolve(path))
  const outputs = [paths.gatewayOutput, paths.imageOutput, paths.videoOutput].map(path => resolve(path))
  const backup = resolve(paths.backupDirectory)
  if (new Set([...inputs, ...outputs, backup]).size !== inputs.length + outputs.length + 1) fail('input, output and backup paths must be distinct')
  for (const output of outputs) assertExistingDirectory(dirname(output), `output directory for ${basename(output)}`)
  assertExistingDirectory(dirname(backup), 'backup parent directory')
  assertOutputsAbsent(outputs)
  try { lstatSync(backup); fail('refusing to replace existing backup directory') } catch (error) {
    if (error instanceof Error && error.message.startsWith('Relay secret migration failed:')) throw error
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      fail('cannot inspect backup directory')
    }
  }
}

function writeNewFileAtomically(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    const bytes = Buffer.from(contents, 'utf8')
    for (let offset = 0; offset < bytes.byteLength;) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
    }
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    // link(2) has O_EXCL-like destination behavior: it cannot overwrite a file
    // raced into place after preflight. The final path becomes visible atomically.
    linkSync(temporary, path)
    unlinkSync(temporary)
    fsyncDirectory(dirname(path))
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* best-effort temp cleanup */ }
    throw error
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeRootOnlyBackup(directory: string, inputs: ReadonlyArray<{ source: string; name: string }>): void {
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o700)
  for (const { source, name } of inputs) {
    const target = `${directory}/${name}`
    copyFileSync(source, target)
    chmodSync(target, 0o600)
    fsyncFile(target)
    fsyncDirectory(directory)
  }
}

function removeCreated(paths: readonly string[]): void {
  for (const path of paths) {
    try { unlinkSync(path) } catch { /* only paths created by this invocation */ }
  }
}

/** Validate first; apply only as root; never print or return environment values. */
export function migrateRelaySecrets(options: MigrationOptions): { status: 'validated' | 'migrated' } {
  const paths: MigrationPaths = options
  assertPaths(paths)
  const plan = buildMigrationPlan(
    readEnvironment(paths.gatewayInput, 'gateway.env'),
    readEnvironment(paths.imageInput, 'relay.env'),
    readEnvironment(paths.videoInput, 'video-media-relay.env'),
    { useSmallProductionProfile: options.useSmallProductionProfile },
  )
  // Explicit source values win over defaults, but only after the exact three
  // production validators accept the complete target. This prevents a typo
  // from being preserved into an unusable output that the exclusive writer
  // would then refuse to replace on a second run.
  validateDeploymentEnvironment(plan.gateway)
  validateRelayDeploymentEnvironment(plan.image)
  validateVideoMediaRelayEnvironment(plan.video)
  if (options.validateOnly) return { status: 'validated' }
  if ((options.enforceRoot ?? true) && process.getuid?.() !== 0) fail('apply mode must run as root so backups are root-only')

  writeRootOnlyBackup(paths.backupDirectory, [
    { source: paths.gatewayInput, name: 'gateway.env' },
    { source: paths.imageInput, name: 'relay.env' },
    { source: paths.videoInput, name: 'video-media-relay.env' },
  ])
  const created: string[] = []
  try {
    for (const [path, contents] of [
      [paths.gatewayOutput, render(plan.gateway)],
      [paths.imageOutput, render(plan.image)],
      [paths.videoOutput, render(plan.video)],
    ] as const) {
      writeNewFileAtomically(path, contents)
      created.push(path)
    }
  } catch (error) {
    removeCreated(created)
    throw error
  }
  return { status: 'migrated' }
}

function parseArguments(argv: readonly string[]): MigrationOptions {
  let validateOnly = false
  let useSmallProductionProfile = false
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--validate-only' || argument === '--dry-run') { validateOnly = true; continue }
    if (argument === '--use-small-production-profile') {
      if (useSmallProductionProfile) fail('--use-small-production-profile may be supplied only once')
      useSmallProductionProfile = true
      continue
    }
    if (!argument.startsWith('--')) fail('unrecognized command-line argument')
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a path`)
    if (values[argument] !== undefined) fail(`${argument} may be supplied only once`)
    values[argument] = value
    index += 1
  }
  const required = ['--gateway-in', '--image-in', '--video-in', '--gateway-out', '--image-out', '--video-out', '--backup-dir'] as const
  for (const name of required) if (!values[name]) fail(`missing ${name}`)
  return {
    gatewayInput: values['--gateway-in']!, imageInput: values['--image-in']!, videoInput: values['--video-in']!,
    gatewayOutput: values['--gateway-out']!, imageOutput: values['--image-out']!, videoOutput: values['--video-out']!,
    backupDirectory: values['--backup-dir']!, validateOnly, useSmallProductionProfile,
  }
}

if (import.meta.main) {
  try {
    const result = migrateRelaySecrets(parseArguments(process.argv.slice(2)))
    console.log(result.status === 'validated' ? 'Relay secret migration preflight passed.' : 'Relay secret migration completed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Relay secret migration failed.')
    process.exitCode = 1
  }
}
