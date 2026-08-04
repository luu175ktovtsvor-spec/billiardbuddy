import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { parse } from 'smol-toml'

const execFileAsync = promisify(execFile)
const MAX_SCRIPT_BYTES = 16 * 1024
const MAX_ACTIONS = 64

export type LocalEnvironmentScript = {
  script?: string
  darwin?: string
  linux?: string
  win32?: string
}

export type LocalEnvironmentAction = {
  name: string
  command: string
  icon?: string
  platforms?: NodeJS.Platform[]
}

export type LocalEnvironmentDefinition = {
  version: number
  name: string
  setup?: LocalEnvironmentScript
  cleanup?: LocalEnvironmentScript
  actions: LocalEnvironmentAction[]
}

export type LocalEnvironmentRunResult = {
  kind: 'setup' | 'cleanup' | 'action'
  name?: string
  startedAt: number
  finishedAt: number
  exitCode: number
}

function definitionPath(worktreePath: string): string {
  return path.join(worktreePath, '.codex', 'environments', 'environment.toml')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function scriptValue(value: unknown): LocalEnvironmentScript | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') {
    const script = optionalEnvironmentScript(value)
    return script === undefined ? undefined : { script }
  }
  if (!isRecord(value) || !Object.keys(value).every(key => ['script', 'darwin', 'linux', 'win32'].includes(key))) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  const result: LocalEnvironmentScript = {}
  for (const key of ['script', 'darwin', 'linux', 'win32'] as const) {
    const candidate = value[key]
    if (candidate === undefined) continue
    if (key === 'script' || typeof candidate === 'string') {
      const script = optionalEnvironmentScript(candidate)
      if (script !== undefined) result[key] = script
      continue
    }
    if (!isRecord(candidate) || !Object.keys(candidate).every(item => item === 'script')) {
      throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
    }
    const script = optionalEnvironmentScript(candidate.script)
    if (script !== undefined) result[key] = script
  }
  return Object.keys(result).length ? result : undefined
}

function optionalEnvironmentScript(value: unknown): string | undefined {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SCRIPT_BYTES || value.includes('\u0000')) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  // Codex's own environment.toml can deliberately leave setup empty while
  // still exposing valid actions. Treat that as no setup, never as a broken
  // environment definition that blocks the entire worktree.
  return value.trim() ? value : undefined
}

function validateScript(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_SCRIPT_BYTES || value.includes('\u0000')) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  return value
}

function action(value: unknown): LocalEnvironmentAction {
  if (!isRecord(value) || !Object.keys(value).every(key => ['name', 'icon', 'command', 'platform', 'platforms'].includes(key))) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(value.name)) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  if (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.length > 256 || /[\u0000\r\n]/.test(value.icon))) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  const platformValue = value.platforms ?? value.platform
  let platforms: NodeJS.Platform[] | undefined
  if (platformValue !== undefined) {
    const raw = typeof platformValue === 'string' ? [platformValue] : platformValue
    if (!Array.isArray(raw) || !raw.length || !raw.every(item => item === 'darwin' || item === 'linux' || item === 'win32')) {
      throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
    }
    platforms = [...new Set(raw)] as NodeJS.Platform[]
  }
  return { name: value.name, command: validateScript(value.command), ...(value.icon ? { icon: value.icon } : {}), ...(platforms ? { platforms } : {}) }
}

function parseDefinition(raw: string): LocalEnvironmentDefinition {
  let parsed: unknown
  try { parsed = parse(raw) } catch { throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID') }
  if (!isRecord(parsed) || !Object.keys(parsed).every(key => ['version', 'name', 'setup', 'cleanup', 'actions'].includes(key))) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  if (parsed.version !== 1 || typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 160 || /[\u0000\r\n]/.test(parsed.name)) {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  }
  if (parsed.actions !== undefined && (!Array.isArray(parsed.actions) || parsed.actions.length > MAX_ACTIONS)) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  const actions = (parsed.actions ?? []).map(action)
  if (new Set(actions.map(item => item.name.toLocaleLowerCase())).size !== actions.length) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')
  return { version: 1, name: parsed.name, setup: scriptValue(parsed.setup), cleanup: scriptValue(parsed.cleanup), actions }
}

async function canonicalDirectory(value: string): Promise<string> {
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\u0000\r\n]/.test(value)) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_WORKTREE_INVALID')
  try {
    const resolved = await fs.realpath(value)
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error()
    return resolved
  } catch { throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_WORKTREE_INVALID') }
}

async function gitCommonDirectory(workspace: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', workspace, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    const value = result.stdout.trim()
    return await fs.realpath(path.isAbsolute(value) ? value : path.join(workspace, value))
  } catch {
    throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_WORKTREE_INVALID')
  }
}

async function relatedWorkspaces(sourceTree: string, worktreePath: string): Promise<[string, string]> {
  const [source, worktree] = await Promise.all([
    canonicalDirectory(sourceTree),
    canonicalDirectory(worktreePath),
  ])
  const [sourceCommon, worktreeCommon] = await Promise.all([
    gitCommonDirectory(source),
    gitCommonDirectory(worktree),
  ])
  if (sourceCommon !== worktreeCommon) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_WORKTREE_INVALID')
  return [source, worktree]
}

function choose(script: LocalEnvironmentScript | undefined, platform: NodeJS.Platform): string | undefined {
  if (!script) return undefined
  return script[platform as keyof LocalEnvironmentScript] ?? script.script
}

function runtimeEnvironment(sourceTree: string, worktreePath: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never pass provider keys, access tokens, or the full desktop environment into repository scripts.
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL']
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) if (base[key]) environment[key] = base[key]
  environment.CODEX_SOURCE_TREE_PATH = sourceTree
  environment.CODEX_WORKTREE_PATH = worktreePath
  return environment
}

async function execute(
  script: string,
  input: { platform: NodeJS.Platform, sourceTree: string, worktreePath: string, environment: NodeJS.ProcessEnv, now?: () => number },
  kind: LocalEnvironmentRunResult['kind'],
  name?: string,
): Promise<LocalEnvironmentRunResult> {
  const startedAt = input.now?.() ?? Date.now()
  const command = input.platform === 'win32'
    ? { file: input.environment.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', script] }
    : { file: '/bin/sh', args: ['-lc', script] }
  let exitCode = 0
  try {
    await execFileAsync(command.file, command.args, {
      cwd: input.worktreePath,
      env: runtimeEnvironment(input.sourceTree, input.worktreePath, input.environment),
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 15 * 60_000,
    })
  } catch (error) {
    exitCode = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
  }
  // stdout/stderr intentionally never leave this host service: setup files can contain credentials.
  const result: LocalEnvironmentRunResult = { kind, startedAt, finishedAt: input.now?.() ?? Date.now(), exitCode }
  if (name) result.name = name
  return result
}

export class LocalEnvironmentHost {
  constructor(private readonly options: { platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv, now?: () => number } = {}) {}

  async read(worktreePath: string): Promise<LocalEnvironmentDefinition | undefined> {
    const workspace = await canonicalDirectory(worktreePath)
    const file = definitionPath(workspace)
    const raw = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    return raw === undefined ? undefined : parseDefinition(raw)
  }

  async runSetup(input: { sourceTree: string, worktreePath: string }): Promise<LocalEnvironmentRunResult | undefined> {
    return await this.runScript(input, 'setup')
  }

  async runCleanup(input: { sourceTree: string, worktreePath: string }): Promise<LocalEnvironmentRunResult | undefined> {
    return await this.runScript(input, 'cleanup')
  }

  async resolveAction(input: { worktreePath: string, name: string }): Promise<LocalEnvironmentAction> {
    if (typeof input.name !== 'string' || !input.name || input.name.length > 80) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_ACTION_INVALID')
    const platform = this.options.platform ?? process.platform
    const definition = await this.read(input.worktreePath)
    if (!definition) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_NOT_FOUND')
    const item = definition.actions.find(action => action.name === input.name)
    if (!item || (item.platforms && !item.platforms.includes(platform))) throw new Error('BILLIARDBUDDY_LOCAL_ENVIRONMENT_ACTION_INVALID')
    return structuredClone(item)
  }

  private async runScript(input: { sourceTree: string, worktreePath: string }, kind: 'setup' | 'cleanup'): Promise<LocalEnvironmentRunResult | undefined> {
    const platform = this.options.platform ?? process.platform
    const [[sourceTree, worktreePath], definition] = await Promise.all([
      relatedWorkspaces(input.sourceTree, input.worktreePath),
      this.read(input.worktreePath),
    ])
    if (!definition) return undefined
    const script = choose(definition[kind], platform)
    if (!script) return undefined
    return await execute(script, {
      platform, sourceTree, worktreePath, environment: this.options.environment ?? process.env, now: this.options.now,
    }, kind)
  }
}
