import Ajv2020 from 'ajv/dist/2020.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { PROVIDER_REGISTRY, providerManifestSha256, providerRegistrySha256, renderProviderContractArtifacts, stableProviderJson, validateProviderRegistryEntry, validateProviderRuntimeConfiguration } from '../../../gateway/providerRegistry.js'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type SourceReference = {
  path: string
  text: string
  pointer?: string
}
type DeletionEdge = {
  object: { id: string, symbol: string, definition: SourceReference }
  consumer: {
    path: string
    symbol: string
    reference: SourceReference & { kind: 'import' | 'dynamic_import' | 'call' | 'new' | 'jsx' | 'registration' | 'command' | 'json_entry' }
  }
  condition: string
}
type DeletionCandidate = {
  object_id: string
  edges: DeletionEdge[]
  migration_modules: string[]
  d4_owner_module: string
  retained_reader: string
}
type AuthPolicyEvidence = { constraint: string, path: string, test_id: string }
type AuthPolicyRegistration = { path: string, required_evidence: AuthPolicyEvidence[] }
type Source = {
  contract_version: number
  generated_by: string
  baseline: Record<string, Json>
  legacy_support: Array<Record<string, Json>>
  policy_schemas: Array<[string, string]>
  deletion_candidates: DeletionCandidate[]
  auth_entitlement_policy: AuthPolicyRegistration
}

const root = resolve(import.meta.dir, '../../..')
const sourcePath = resolve(root, 'ts/product-contracts/contract-source.json')
const outputDir = resolve(root, 'ts/product-contracts')

function stable(value: Json): Json {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function stringify(value: Json): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json
}

function sourceHash(source: Source): string {
  return sha256(stringify(source as unknown as Json))
}

function legacySupportMatrixSchema(sourceDigest: string): Json {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'billiardbuddy/legacy-support-matrix.schema.json',
    type: 'object',
    additionalProperties: false,
    required: ['matrix_schema_version', 'matrix_revision', 'source_sha256', 'entries'],
    properties: {
      matrix_schema_version: { const: 1 },
      matrix_revision: { type: 'string', minLength: 1 },
      source_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      entries: { type: 'array', minItems: 1, items: { type: 'object', required: ['id', 'status', 'storage_id', 'layer'], properties: { id: { type: 'string' }, status: { enum: ['supported', 'current', 'provisional', 'current_only', 'unsupported'] }, storage_id: { type: 'string' }, layer: { enum: ['disk', 'wire', 'localStorage'] }, fixture: { type: 'string' }, fixture_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reader_entry: { type: 'string' }, positive_test: { type: 'string' }, positive_test_id: { type: 'string' }, idempotence_test: { type: 'string' }, idempotence_test_id: { type: 'string' }, migration_owner_module: { type: 'string' }, backup_strategy: { type: 'string' }, release_association: { type: 'string' } } } },
    },
    'x-contract-source-sha256': sourceDigest,
  }
}

function componentSchema(sourceDigest: string): Json {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'billiardbuddy/component-compatibility-matrix.schema.json',
    title: 'BilliardBuddy component compatibility matrix',
    type: 'object',
    additionalProperties: false,
    required: ['matrix_schema_version', 'matrix_revision', 'release_id', 'candidate_id', 'minimum_supported_release', 'components', 'required_edges', 'model_catalog_revision', 'legacy_support_matrix', 'rollout'],
    properties: {
      matrix_schema_version: { type: 'integer', minimum: 1 },
      matrix_revision: { type: 'string', minLength: 1 },
      release_id: { type: 'string', minLength: 1 },
      candidate_id: { type: 'string', minLength: 1 },
      minimum_supported_release: { type: 'string', minLength: 1 },
      model_catalog_revision: { type: 'string', minLength: 1 },
      required_edges: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['from', 'to', 'protocol', 'required_capability'], properties: { from: { type: 'string' }, to: { type: 'string' }, protocol: { type: 'string' }, required_capability: { type: 'string' } } } },
      legacy_support_matrix: { type: 'object', additionalProperties: false, required: ['matrix_revision', 'sha256'], properties: { matrix_revision: { type: 'string', minLength: 1 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      rollout: { type: 'object', additionalProperties: false, required: ['accepts_release_range', 'rollback_floor', 'retire_after'], properties: { accepts_release_range: { type: 'string' }, rollback_floor: { type: 'string' }, retire_after: { type: 'string' } } },
      components: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['component_name', 'artifact_version', 'build_id', 'platform', 'arch', 'protocols', 'capabilities', 'required_capabilities', 'consumes', 'produces', 'schemas'], properties: { component_name: { type: 'string' }, artifact_version: { type: 'string' }, build_id: { type: 'string' }, platform: { type: 'string' }, arch: { type: 'string' }, protocols: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'supported_ranges'], properties: { name: { type: 'string' }, supported_ranges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['major', 'min_minor', 'max_minor'], properties: { major: { type: 'integer' }, min_minor: { type: 'integer' }, max_minor: { type: 'integer' } } } } } } }, capabilities: { type: 'array', items: { type: 'string' } }, required_capabilities: { type: 'array', items: { type: 'string' } }, consumes: { type: 'array', items: { type: 'string' } }, produces: { type: 'array', items: { type: 'string' } }, schemas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['storage_id', 'current', 'min_readable', 'min_writable'], properties: { storage_id: { type: 'string' }, current: { type: 'string' }, min_readable: { type: 'string' }, min_writable: { type: 'string' } } } } } } },
    },
    'x-contract-source-sha256': sourceDigest,
  }
}

function releaseChecklistSchema(sourceDigest: string, policyIds: string[]): Json {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'billiardbuddy/release-checklist.schema.json',
    title: 'BilliardBuddy release checklist',
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'candidate_id', 'component_matrix_digest', 'policy_digests', 'items'],
    properties: {
      schema_version: { type: 'integer', minimum: 1 },
      candidate_id: { type: 'string', minLength: 1 },
      component_matrix_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      policy_digests: {
        type: 'object',
        additionalProperties: false,
        required: policyIds,
        properties: Object.fromEntries(policyIds.map((policyId) => [policyId, { type: 'string', pattern: '^[a-f0-9]{64}$' }])),
      },
      items: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['check_id', 'module', 'required', 'platform', 'candidate_input', 'procedure', 'pass_condition', 'evidence_path', 'owner', 'result'], properties: { check_id: { type: 'string' }, module: { type: 'string' }, required: { type: 'boolean' }, platform: { type: 'string' }, candidate_input: { type: 'string' }, procedure: { type: 'string' }, pass_condition: { type: 'string' }, evidence_path: { type: 'string' }, owner: { enum: ['machine', 'user'] }, result: { enum: ['PASS', 'FAIL', 'NOT_RUN', 'UNVERIFIED'] } } } },
    },
    'x-contract-source-sha256': sourceDigest,
  }
}

export function render(source: Source): Record<string, Json> {
  const digest = sourceHash(source)
  const policies = source.policy_schemas.map(([policy_id, owner_module]) => ({
    policy_id,
    owner_module,
    schema_version: 1,
    required_fields: policy_id === 'system-support-policy'
      ? ['policy_schema_version', 'policy_revision', 'owner_module', 'sha256', 'evidence', 'supported_platforms', 'minimum_os', 'minimum_ram_bytes', 'minimum_available_disk_bytes', 'filesystem_requirements', 'minimum_chrome_extension_version']
      : ['policy_schema_version', 'policy_revision', 'owner_module', 'sha256', 'evidence'],
    required_evidence: policy_id === 'system-support-policy' ? ['candidate_install_test', 'electron_node_native_module_versions', 'chrome_protocol_version'] : ['owner-module-evidence'],
    initial_declaration: policy_id === 'system-support-policy' ? 'module-01-schema-only; module-24 is the sole registry that records candidate support values' : undefined,
    hash_scope: 'canonical policy document excluding its sha256 field',
  }))
  return {
    'single-product-baseline.json': { baseline_schema_version: 1, source_sha256: digest, ...source.baseline },
    'legacy-support-matrix.json': {
      matrix_schema_version: 1,
      matrix_revision: 'bb-01a-initial',
      source_sha256: digest,
      entries: source.legacy_support.map((entry) => ({
        ...entry,
        ...(entry.fixture ? { fixture_sha256: sha256(readFileSync(resolve(root, String(entry.fixture)), 'utf8')) } : {}),
      })),
    },
    'legacy-support-matrix.schema.json': legacySupportMatrixSchema(digest),
    'component-compatibility-matrix.schema.json': componentSchema(digest),
    'release-checklist.schema.json': releaseChecklistSchema(digest, source.policy_schemas.map(([policyId]) => policyId)),
    'policy-schemas.json': { manifest_schema_version: 1, source_sha256: digest, policies },
    'deletion-consumer-graph.json': {
      graph_schema_version: 1,
      source_sha256: digest,
      candidates: source.deletion_candidates.map((candidate) => ({ ...candidate, d5_owner_module: '24' })),
    },
    ...renderProviderContractArtifacts(),
  }
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type ComponentFixture = {
  component_name: string
  protocols: Array<{ name: string, supported_ranges: Array<{ major: number, min_minor: number, max_minor: number }> }>
  capabilities: string[]
  required_capabilities: string[]
  consumes: string[]
  produces: string[]
}
type ComponentMatrixFixture = {
  components: ComponentFixture[]
  required_edges: Array<{ from: string, to: string, protocol: string, required_capability: string }>
}

function componentSemantics(matrix: ComponentMatrixFixture): boolean {
  const byName = new Map<string, ComponentFixture>(matrix.components.map((component) => [component.component_name, component]))
  for (const component of matrix.components) {
    for (const protocol of component.protocols) {
      for (const range of protocol.supported_ranges) {
        if (range.min_minor > range.max_minor) return false
      }
    }
  }
  return matrix.required_edges.every((edge: any) => {
    const producer = byName.get(edge.from)
    const consumer = byName.get(edge.to)
    if (!producer || !consumer) return false
    if (!producer.produces.includes(edge.protocol) || !consumer.consumes.includes(edge.protocol)) return false
    if (!producer.capabilities.includes(edge.required_capability) || !consumer.required_capabilities.includes(edge.required_capability)) return false
    const offered = producer.protocols.find((protocol) => protocol.name === edge.protocol)?.supported_ranges ?? []
    const accepted = consumer.protocols.find((protocol) => protocol.name === edge.protocol)?.supported_ranges ?? []
    return offered.some((left) => accepted.some((right) => (
      left.major === right.major
      && Math.max(left.min_minor, right.min_minor) <= Math.min(left.max_minor, right.max_minor)
    )))
  })
}

function validateSchemaSemantics(source: Source, artifacts: Record<string, Json>): void {
  const fixtures = parseJson(resolve(root, 'ts/product-contracts/schema-semantic-fixtures.json')) as any
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validateComponent = ajv.compile(artifacts['component-compatibility-matrix.schema.json'] as object)
  const validateRelease = ajv.compile(artifacts['release-checklist.schema.json'] as object)
  requireCondition(validateComponent(fixtures.component.valid), `valid component fixture fails formal schema: ${ajv.errorsText(validateComponent.errors)}`)
  requireCondition(componentSemantics(fixtures.component.valid as ComponentMatrixFixture), 'valid component semantic fixture rejected')
  for (const invalid of fixtures.component.semantic_invalid) {
    requireCondition(validateComponent(invalid), `semantic-invalid component fixture fails formal schema: ${ajv.errorsText(validateComponent.errors)}`)
    requireCondition(!componentSemantics(invalid as ComponentMatrixFixture), 'invalid component semantic fixture accepted')
  }
  requireCondition(validateRelease(fixtures.release.valid), `valid release fixture fails formal schema: ${ajv.errorsText(validateRelease.errors)}`)
  requireCondition(fixtures.release.valid.items.length > 0 && source.policy_schemas.every(([policy]) => /^[a-f0-9]{64}$/.test(fixtures.release.valid.policy_digests[policy] ?? '')), 'valid release semantic fixture rejected')
  requireCondition(!validateRelease(fixtures.release.invalid), 'invalid release fixture accepted by formal schema')
  const missingPolicyDigest = structuredClone(fixtures.release.valid)
  delete missingPolicyDigest.policy_digests[fixtures.release.invalid_missing_policy_digest]
  requireCondition(!validateRelease(missingPolicyDigest), 'release fixture missing a required policy digest accepted by formal schema')
  const unknownPolicyDigest = structuredClone(fixtures.release.valid)
  unknownPolicyDigest.policy_digests[fixtures.release.invalid_unknown_policy_digest] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  requireCondition(!validateRelease(unknownPolicyDigest), 'release fixture with an unknown policy digest accepted by formal schema')
  const wrongPolicyDigest = structuredClone(fixtures.release.valid)
  wrongPolicyDigest.policy_digests[fixtures.release.invalid_wrong_policy_digest] = 'not-a-sha256-digest'
  requireCondition(!validateRelease(wrongPolicyDigest), 'release fixture with an invalid policy digest accepted by formal schema')
}

function jsonPointer(value: unknown, pointer: string): unknown {
  requireCondition(pointer.startsWith('/'), `invalid JSON pointer: ${pointer}`)
  return pointer.slice(1).split('/').reduce((current: any, segment) => (
    current && typeof current === 'object'
      ? current[segment.replaceAll('~1', '/').replaceAll('~0', '~')]
      : undefined
  ), value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function validateConsumerReference(edge: DeletionEdge, source: string): void {
  const { kind, text, pointer } = edge.consumer.reference
  const symbol = escapeRegExp(edge.object.symbol)
  requireCondition(source.includes(text), `missing exact consumer reference for ${edge.object.id} -> ${edge.consumer.path}`)
  if (kind === 'import') {
    requireCondition(new RegExp(`^import[\\s\\S]*\\b${symbol}\\b[\\s\\S]*from\\s*['\"]`, 'm').test(text), `invalid import edge for ${edge.object.id}`)
  } else if (kind === 'dynamic_import') {
    requireCondition(text.includes(edge.object.symbol) && /await import\(['"]/.test(text), `invalid dynamic import edge for ${edge.object.id}`)
  } else if (kind === 'call') {
    requireCondition(new RegExp(`\\b${symbol}\\s*\\(`).test(text), `invalid call edge for ${edge.object.id}`)
  } else if (kind === 'new') {
    requireCondition(new RegExp(`\\bnew\\s+${symbol}\\s*\\(`).test(text), `invalid constructor edge for ${edge.object.id}`)
  } else if (kind === 'jsx') {
    requireCondition(new RegExp(`<${symbol}(?:\\s|/|>|$)`).test(text), `invalid JSX edge for ${edge.object.id}`)
  } else if (kind === 'registration') {
    requireCondition(new RegExp(`(?:\\[|,)\\s*${symbol}\\s*(?:,|\\])`).test(text), `invalid registration edge for ${edge.object.id}`)
  } else if (kind === 'command') {
    requireCondition(new RegExp(`\\bbun run ${symbol}\\b`).test(text), `invalid command edge for ${edge.object.id}`)
  } else {
    requireCondition(Boolean(pointer), `missing JSON Pointer for ${edge.object.id}`)
    requireCondition(jsonPointer(parseJson(resolve(root, edge.consumer.path)), pointer!) === edge.object.symbol, `JSON consumer does not reference object entry for ${edge.object.id}`)
  }
}

function validateDeletionGraph(source: Source): void {
  for (const candidate of source.deletion_candidates) {
    requireCondition(candidate.object_id.length > 0 && candidate.edges.length > 0 && candidate.migration_modules.length > 0 && candidate.retained_reader.length > 0, `incomplete deletion candidate: ${candidate.object_id}`)
    for (const edge of candidate.edges) {
      requireCondition(edge.object.id === candidate.object_id && edge.object.symbol.length > 0, `invalid deletion object edge: ${candidate.object_id}`)
      requireCondition(edge.object.definition.path.length > 0 && edge.object.definition.text.length > 0 && edge.consumer.path.length > 0 && edge.consumer.symbol.length > 0 && edge.condition.length > 0, `incomplete deletion edge: ${candidate.object_id}`)
      const definitionPath = resolve(root, edge.object.definition.path)
      const consumerPath = resolve(root, edge.consumer.path)
      requireCondition(existsSync(definitionPath), `missing object definition: ${candidate.object_id} -> ${edge.object.definition.path}`)
      requireCondition(existsSync(consumerPath), `missing deletion consumer: ${candidate.object_id} -> ${edge.consumer.path}`)
      const definitionSource = readFileSync(definitionPath, 'utf8')
      const consumerSource = readFileSync(consumerPath, 'utf8')
      requireCondition(definitionSource.includes(edge.object.definition.text) && edge.object.definition.text.includes(edge.object.symbol), `missing object definition evidence for ${candidate.object_id}`)
      requireCondition(
        edge.consumer.reference.text !== edge.object.definition.text
          || (edge.consumer.reference.kind === 'json_entry' && edge.consumer.reference.pointer !== edge.object.definition.pointer),
        `object definition cannot be its own consumer: ${candidate.object_id}`,
      )
      if (edge.consumer.reference.kind === 'json_entry') {
        requireCondition(Boolean(edge.object.definition.pointer), `missing JSON definition pointer for ${candidate.object_id}`)
        requireCondition(jsonPointer(parseJson(definitionPath), edge.object.definition.pointer!) === edge.object.symbol, `JSON definition does not match object entry for ${candidate.object_id}`)
      }
      validateConsumerReference(edge, consumerSource)
    }
    for (const module of candidate.migration_modules) requireCondition(/^\d{2}(?:-\d{2}|[A-Z])?$/.test(module), `invalid migration module for ${candidate.object_id}: ${module}`)
    requireCondition(candidate.d4_owner_module === '23' || candidate.d4_owner_module === 'none', `invalid D4 owner for ${candidate.object_id}`)
  }
}

export const REQUIRED_AUTH_POLICY_CONSTRAINTS = [
  'cross_process_transaction',
  'lock_owner_identity',
  'provisioning_revision',
  'session_revocation',
  'sidecar_rotation',
  'host_env_scrub',
  'refresh_proof_logout',
  'strict_device_limit',
] as const

export function validateAuthEntitlementPolicy(policy: Record<string, Json>, registration: AuthPolicyRegistration): void {
  requireCondition(policy.policy_schema_version === 1 && policy.policy_revision === 'bb-04a-license-activation', 'auth entitlement policy schema is invalid')
  requireCondition(policy.owner_module === '04', 'auth entitlement policy owner is invalid')
  requireCondition(policy.authorization && (policy.authorization as Record<string, Json>).sole_activation_route === 'license', 'auth entitlement policy must select License activation')
  requireCondition((policy.authorization as Record<string, Json>).owner === 'verified_principal_and_installation', 'auth entitlement policy owner is invalid')
  requireCondition((policy.authorization as Record<string, Json>).bootstrap_credential === 'activation_only', 'auth entitlement bootstrap policy is invalid')
  const constraints = policy.constraints as Record<string, Json> | undefined
  for (const constraint of REQUIRED_AUTH_POLICY_CONSTRAINTS) {
    requireCondition(constraints?.[constraint] === true, `auth entitlement policy missing constraint: ${constraint}`)
  }
  requireCondition(Array.isArray(policy.evidence), 'auth entitlement policy evidence is invalid')
  const evidence = policy.evidence as unknown as AuthPolicyEvidence[]
  requireCondition(evidence.length === registration.required_evidence.length, 'auth entitlement policy evidence drift')
  for (const expected of registration.required_evidence) {
    const actual = evidence.find((entry) => entry.constraint === expected.constraint)
    requireCondition(actual && actual.path === expected.path && actual.test_id === expected.test_id, `auth entitlement policy behavior evidence drift: ${expected.constraint}`)
    const evidencePath = resolve(root, expected.path)
    requireCondition(existsSync(evidencePath), `missing auth entitlement evidence: ${expected.path}`)
    requireCondition(readFileSync(evidencePath, 'utf8').includes(expected.test_id), `missing auth entitlement test ID: ${expected.constraint}`)
  }
  requireCondition(new Set(evidence.map((entry) => entry.constraint)).size === evidence.length, 'auth entitlement policy evidence duplicates a constraint')
  for (const constraint of REQUIRED_AUTH_POLICY_CONSTRAINTS) {
    requireCondition(evidence.some((entry) => entry.constraint === constraint), `auth entitlement policy missing behavior evidence: ${constraint}`)
  }
  const unsignedPolicy = { ...policy }
  delete unsignedPolicy.sha256
  requireCondition(policy.sha256 === sha256(stringify(unsignedPolicy)), 'auth entitlement policy hash mismatch')
}

export function validateAuthEntitlementPolicyFile(registration: AuthPolicyRegistration, file = resolve(root, registration.path)): void {
  requireCondition(existsSync(file), 'missing auth entitlement policy')
  validateAuthEntitlementPolicy(parseJson(file) as Record<string, Json>, registration)
}

type ProviderFixture = { name: string, env: Record<string, string>, expected: string }

function validateProviderRegistryArtifacts(artifacts: Record<string, Json>): void {
  const generated = renderProviderContractArtifacts()
  const contract = artifacts['model-contract.json'] as Record<string, any>
  const manifest = artifacts['worker-capability-manifest.json'] as Record<string, any>
  requireCondition(stableProviderJson(contract) === stableProviderJson(generated['model-contract.json']), 'model contract is not generated from provider registry')
  requireCondition(stableProviderJson(manifest) === stableProviderJson(generated['worker-capability-manifest.json']), 'worker capability manifest is not generated from provider registry')
  requireCondition(contract.registry_sha256 === providerRegistrySha256() && manifest.registry_sha256 === providerRegistrySha256(), 'provider artifacts must share canonical registry hash')
  requireCondition(contract.worker_capability_manifest?.registry_sha256 === manifest.registry_sha256 && manifest.model_contract?.registry_sha256 === contract.registry_sha256, 'provider artifacts must cross-reference canonical registry hash')
  requireCondition(providerManifestSha256() === sha256(stableProviderJson(manifest)), 'worker capability manifest hash mismatch')
  const secret = /(?:api[_-]?key|token|secret|password|credential)/i
  const serialized = stableProviderJson({ contract, manifest } as unknown as Json)
  requireCondition(!secret.test(serialized), 'provider artifacts must not contain secrets')
  requireCondition(PROVIDER_REGISTRY.length > 0 && PROVIDER_REGISTRY.every(entry => entry.verified_context_window >= 16_000 && entry.verified_context_window < 1_000_000), 'provider registry has unsupported context window')
  requireCondition(PROVIDER_REGISTRY.every(entry => entry.resume_evidence.path && existsSync(resolve(root, entry.resume_evidence.path))), 'provider registry evidence path is missing')
  for (const entry of PROVIDER_REGISTRY) {
    const caps = entry.body_caps
    requireCondition(caps.CHAT_TEXT_BODY_MAX_BYTES > 0 && caps.VISION_BODY_MAX_BYTES > 0 && caps.IMAGE_GENERATION_BODY_MAX_BYTES > 0, `invalid body caps for ${entry.model_id}`)
  }
  const fixtures = parseJson(resolve(root, 'ts/product-contracts/fixtures/provider-registry-fixtures.json')) as unknown as {
    invalid: ProviderFixture[]
    unsupported: {
      stale: { verification_date: string }
      one_megabyte_window: { verified_context_window: number }
      body_caps: { CHAT_TEXT_BODY_MAX_BYTES: number, VISION_BODY_MAX_BYTES: number, IMAGE_GENERATION_BODY_MAX_BYTES: number }
    }
  }
  for (const fixture of fixtures.invalid) requireCondition(validateProviderRuntimeConfiguration(fixture.env) === fixture.expected, `provider fixture rejected incorrectly: ${fixture.name}`)
  const baseline = PROVIDER_REGISTRY[0]!
  requireCondition(validateProviderRegistryEntry({ ...baseline, ...fixtures.unsupported.stale }) === 'MODEL_CONTRACT_STALE', 'stale provider fixture accepted')
  requireCondition(validateProviderRegistryEntry({ ...baseline, ...fixtures.unsupported.one_megabyte_window }) === 'MODEL_CONTRACT_STALE', '1M unsupported provider fixture accepted')
  requireCondition(validateProviderRegistryEntry({ ...baseline, body_caps: fixtures.unsupported.body_caps }) === 'MODEL_CONTRACT_STALE', 'invalid body cap fixture accepted')
}

export function validate(source: Source, artifacts = render(source)): void {
  requireCondition(source.contract_version === 1, 'contract_version must be 1')
  validateSchemaSemantics(source, artifacts)
  const renderer = source.baseline.renderer as Record<string, Json>
  requireCondition(renderer.entry === 'ts/desktop/src/main.tsx', 'the only renderer entry must be ts/desktop/src/main.tsx')
  const htmlReference = (source.baseline.references as Record<string, Json>).html as Record<string, Json>
  requireCondition(htmlReference.build_input === false, 'HTML reference must not be a build input')
  const desktopPackage = parseJson(resolve(root, 'ts/desktop/package.json')) as any
  const declaredBuild = source.baseline.desktop_build as Record<string, any>
  requireCondition(JSON.stringify(desktopPackage.build.files) === JSON.stringify(declaredBuild.package_inputs), 'desktop package inputs drift from electron-builder files')
  const actualExtraResources = (desktopPackage.build.extraResources as Array<any>).flatMap((item) => (item.filter as string[]).map((name) => `${item.from}/${name}`))
  requireCondition(JSON.stringify(actualExtraResources) === JSON.stringify(declaredBuild.extra_resources), 'desktop extraResources drift from electron-builder inputs')
  const sidecarBuildScript = readFileSync(resolve(root, 'ts/desktop/scripts/build-sidecars.ts'), 'utf8')
  requireCondition(sidecarBuildScript.includes(String(declaredBuild.sidecar_build_entry).replace('ts/desktop/', '')), 'sidecar build entry is not compiled by build-sidecars')
  for (const entry of source.baseline.runtime_entries as Array<Record<string, Json>>) {
    requireCondition(existsSync(resolve(root, String(entry.entry))), `missing runtime entry: ${entry.entry}`)
    for (const consumer of entry.consumers as string[]) requireCondition(existsSync(resolve(root, consumer)), `missing runtime consumer: ${consumer}`)
  }
  const supported = source.legacy_support.filter((entry) => entry.status === 'supported' || entry.status === 'current')
  requireCondition(supported.length === 5, 'initial matrix must have exactly five supported/current disk entries')
  for (const entry of source.legacy_support) {
    const status = String(entry.status)
    if (status === 'supported' || status === 'current') {
      for (const field of ['fixture', 'reader_entry', 'positive_test', 'idempotence_test', 'positive_test_id', 'idempotence_test_id']) requireCondition(Boolean(entry[field]), `${entry.id} lacks ${field}`)
      requireCondition(existsSync(resolve(root, String(entry.fixture))), `missing fixture: ${entry.fixture}`)
      requireCondition(existsSync(resolve(root, String(entry.reader_entry))), `missing reader: ${entry.reader_entry}`)
      requireCondition(existsSync(resolve(root, String(entry.positive_test))), `missing positive migration test: ${entry.id}`)
      requireCondition(existsSync(resolve(root, String(entry.idempotence_test))), `missing idempotence migration test: ${entry.id}`)
      const fixture = parseJson(resolve(root, String(entry.fixture))) as Record<string, Json>
      requireCondition(fixture.support_id === entry.id && fixture.immutable === true, `fixture identity mismatch: ${entry.fixture}`)
    }
    if (status === 'provisional' || status === 'unsupported') requireCondition(!entry.fixture, `${entry.id} must not imply support with a fixture`)
  }
  requireCondition(source.legacy_support.some((entry) => entry.id === 'product-task-wire-v2-current-only' && entry.layer === 'wire' && entry.status === 'current_only'), 'wire v2 must remain current-only and separate from disk migration')
  const authPolicyRegistration = source.auth_entitlement_policy
  requireCondition(authPolicyRegistration?.path === 'ts/product-contracts/auth-entitlement-policy.json', 'auth entitlement policy path is invalid')
  requireCondition(Array.isArray(authPolicyRegistration.required_evidence) && authPolicyRegistration.required_evidence.length === REQUIRED_AUTH_POLICY_CONSTRAINTS.length, 'auth entitlement policy evidence is invalid')
  const authPolicyPath = resolve(root, authPolicyRegistration.path)
  validateAuthEntitlementPolicyFile(authPolicyRegistration, authPolicyPath)
  validateProviderRegistryArtifacts(artifacts)
  validateDeletionGraph(source)
  requireCondition(source.policy_schemas.length === 14, 'all initial policy schemas must be registered')
  for (const policy of ['permission-profile-policy', 'automatic-reviewer-policy']) {
    requireCondition(source.policy_schemas.some(([policyId, ownerModule]) => policyId === policy && ownerModule === '08'), `${policy} must remain owned by module 08`)
  }
  requireCondition(Object.keys(artifacts).length === 9, 'all nine generated artifacts are required')
  const legacyMatrixSchemaArtifact = artifacts['legacy-support-matrix.schema.json'] as any
  const componentSchemaArtifact = artifacts['component-compatibility-matrix.schema.json'] as any
  const releaseSchemaArtifact = artifacts['release-checklist.schema.json'] as any
  requireCondition(legacyMatrixSchemaArtifact.properties.entries.items.properties.fixture_sha256.pattern === '^[a-f0-9]{64}$', 'legacy matrix schema must bind fixture hashes')
  requireCondition(componentSchemaArtifact.required.includes('required_edges'), 'component schema must require edges')
  const policyDigestSchema = releaseSchemaArtifact.properties.policy_digests
  requireCondition(policyDigestSchema.additionalProperties === false && JSON.stringify(policyDigestSchema.required) === JSON.stringify(source.policy_schemas.map(([policyId]) => policyId)), 'release schema must require exactly every policy digest')
  const twice = render(source)
  for (const [name, artifact] of Object.entries(artifacts)) requireCondition(sha256(stringify(artifact)) === sha256(stringify(twice[name])), `non-deterministic generation: ${name}`)
}

function main(): void {
  const source = parseJson(sourcePath) as Source
  const artifacts = render(source)
  validate(source, artifacts)
  const write = process.argv.includes('--write')
  for (const [name, artifact] of Object.entries(artifacts)) {
    const destination = resolve(outputDir, name)
    const rendered = stringify(artifact)
    if (write) {
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, rendered)
    }
    requireCondition(existsSync(destination), `missing generated artifact: ts/product-contracts/${name}; run with --write`)
    requireCondition(readFileSync(destination, 'utf8') === rendered, `stale generated artifact: ts/product-contracts/${name}; regenerate from contract-source.json`)
  }
  process.stdout.write(`product-contracts: PASS ${sha256(stringify(artifacts))}\n`)
}

if (import.meta.main) main()
