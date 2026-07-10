// Python 边桥:本机截图/点击/键鼠的真正执行落在 runtime/{mac,win}_helper.py。
// 对齐 cc-haha src/utils/computerUse/pythonBridge.ts,替换为本项目的状态根/日志/execFile。
//
// 首次调用时惰性 bootstrap:在 <configHome>/.runtime/venv 建虚拟环境、装依赖
// (pyautogui + mss + pyobjc/pywin32),之后每次调用 = 起一个 python 子进程跑
// `helper.py <command> --payload <json>`,读回 {ok, result|error}。

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getUserConfigHomeDir } from '../../harness/memoryNames'
import { getLogger } from '../../utils/logger'

const __dirname_ = path.dirname(fileURLToPath(import.meta.url))
// ts/src/tools/computerUse/pythonBridge.ts → 上溯三层到 ts/ 根。
const projectRoot = path.resolve(__dirname_, '../../..')

const isWindows = process.platform === 'win32'

// 所有运行期状态落 <configHome>/.runtime(开发与打包都可写)。
const runtimeStateRoot = path.join(getUserConfigHomeDir(), '.runtime')
const venvRoot = path.join(runtimeStateRoot, 'venv')
const installStampPath = path.join(runtimeStateRoot, 'requirements.sha256')
const requirementsPath = path.join(runtimeStateRoot, 'requirements.txt')
const helperFileName = isWindows ? 'win_helper.py' : 'mac_helper.py'
const helperPath = path.join(runtimeStateRoot, helperFileName)

/** 运行期源文件目录:env 覆盖(打包时资产管理器落位) > ts/runtime(开发)。 */
function runtimeSourceDir(): string {
  const override = process.env.BILLIARDBUDDY_CU_RUNTIME_DIR?.trim()
  if (override) return override
  return path.join(projectRoot, 'runtime')
}

let bootstrapPromise: Promise<void> | undefined

// 集中式日志(P0,审计 16-trace-errors.md #1.1):落 <stateRoot>/logs/debug.log,
// 默认只记 warn/error,env QF_DEBUG_LOG(或兼容 BILLIARDBUDDY_DEBUG/DEBUG)开 verbose。
const log = getLogger('computer-use')

function debugLog(message: string): void {
  log.debug(message)
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function execFileNoThrow(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(file, args, { env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
    })
  })
}

function getPythonCommandEnv(): NodeJS.ProcessEnv | undefined {
  if (!isWindows) return undefined
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
}

function pythonBinPath(): string {
  return isWindows ? path.join(venvRoot, 'Scripts', 'python.exe') : path.join(venvRoot, 'bin', 'python3')
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

async function runOrThrow(file: string, args: string[], label: string): Promise<string> {
  const { code, stdout, stderr } = await execFileNoThrow(file, args)
  if (code !== 0) {
    throw new Error(`${label} 失败(code ${code}):${stderr || stdout || 'unknown error'}`)
  }
  return stdout
}

/**
 * pip 安装带回退:先直连,失败再走国内镜像(清华 TUNA),兜住大陆网络。
 * 对齐 cc 的 buildPipInstallAttempts 思路,但内置我们自己的镜像列表。
 */
function buildPipInstallAttempts(baseArgs: string[]): string[][] {
  const mirrors = [
    process.env.BILLIARDBUDDY_PIP_INDEX_URL?.trim(),
    'https://pypi.tuna.tsinghua.edu.cn/simple',
  ].filter((x): x is string => !!x)
  const attempts: string[][] = [baseArgs]
  for (const mirror of mirrors) {
    const host = new URL(mirror).host
    attempts.push([...baseArgs, '--index-url', mirror, '--trusted-host', host])
  }
  return attempts
}

async function runPipInstallWithFallback(baseArgs: string[], label: string): Promise<void> {
  let firstFailure = ''
  for (const args of buildPipInstallAttempts(baseArgs)) {
    const { code, stdout, stderr } = await execFileNoThrow(pythonBinPath(), args)
    if (code === 0) return
    if (!firstFailure) firstFailure = `${label} 失败(code ${code}):${stderr || stdout || 'unknown error'}`
  }
  throw new Error(firstFailure || `${label} 失败`)
}

async function installRuntimeDependencies(reqPath: string): Promise<void> {
  await runPipInstallWithFallback(['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip 自升级')
  await runPipInstallWithFallback(['-m', 'pip', 'install', '-r', reqPath], 'python 依赖安装')
}

function getVenvCreationPythonCommand(): string {
  const override = process.env.BILLIARDBUDDY_CU_PYTHON?.trim()
  if (override) return override
  return isWindows ? 'python' : 'python3'
}

/** 把 runtime 源文件同步到 <configHome>/.runtime(源变化即刷新,避免旧脚本残留)。 */
async function ensureRuntimeFiles(): Promise<void> {
  await mkdir(runtimeStateRoot, { recursive: true })
  const srcDir = runtimeSourceDir()
  const devReqFile = isWindows ? 'requirements-win.txt' : 'requirements.txt'
  const devRequirements = path.join(srcDir, devReqFile)
  const devHelper = path.join(srcDir, helperFileName)
  if (await pathExists(devRequirements)) {
    await writeFile(requirementsPath, await readFile(devRequirements, 'utf8'), 'utf8')
  }
  if (await pathExists(devHelper)) {
    await writeFile(helperPath, await readFile(devHelper, 'utf8'), 'utf8')
  }
}

export async function ensureBootstrapped(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise
  bootstrapPromise = (async () => {
    await ensureRuntimeFiles()

    if (!(await pathExists(pythonBinPath()))) {
      debugLog(`创建 venv:${venvRoot}`)
      await runOrThrow(getVenvCreationPythonCommand(), ['-m', 'venv', venvRoot], 'python venv 创建')
    }

    const pipBin = isWindows ? path.join(venvRoot, 'Scripts', 'pip.exe') : path.join(venvRoot, 'bin', 'pip')
    if (!(await pathExists(pipBin))) {
      debugLog('ensurepip 引导 pip')
      await runOrThrow(pythonBinPath(), ['-m', 'ensurepip', '--upgrade'], 'ensurepip')
    }

    const requirements = await readFile(requirementsPath, 'utf8')
    const digest = createHash('sha256').update(requirements).digest('hex')
    let installedDigest = ''
    try {
      installedDigest = (await readFile(installStampPath, 'utf8')).trim()
    } catch {}

    if (installedDigest !== digest) {
      debugLog('安装 python 运行期依赖')
      await installRuntimeDependencies(requirementsPath)
      await writeFile(installStampPath, `${digest}\n`, 'utf8')
    }
  })()

  try {
    await bootstrapPromise
  } catch (error) {
    bootstrapPromise = undefined
    throw error
  }
}

export async function callPythonHelper<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  await ensureBootstrapped()
  const { code, stdout, stderr } = await execFileNoThrow(
    pythonBinPath(),
    [helperPath, command, '--payload', JSON.stringify(payload)],
    getPythonCommandEnv(),
  )

  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr || `python helper ${command} 失败(code ${code})`)
  }

  let parsed: { ok: boolean; result?: T; error?: { message?: string } }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error(stderr || stdout || `python helper ${command} 返回了非法 JSON`)
  }

  if (!parsed.ok) {
    throw new Error(parsed.error?.message || `python helper ${command} 失败`)
  }

  return parsed.result as T
}

export function getRuntimePaths(): { projectRoot: string; runtimeStateRoot: string; venvRoot: string } {
  return { projectRoot, runtimeStateRoot, venvRoot }
}
