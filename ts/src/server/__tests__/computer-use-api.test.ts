import { describe, expect, it } from 'bun:test'

import {
  checkComputerUseStatus,
  getUnsupportedPythonVersionStep,
  handleComputerUseApi,
  installSetupDependencies,
  runPipInstallWithFallback,
} from '../api/computer-use.js'

function makeRequest(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/computer-use/authorized-apps', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function callAuthorizedApps(method: string, body?: unknown): Promise<Response> {
  return handleComputerUseApi(
    makeRequest(method, body),
    new URL('http://localhost/api/computer-use/authorized-apps'),
    ['api', 'computer-use', 'authorized-apps'],
  )
}

describe('Computer Use API authorization boundary', () => {
  it('reports setup readiness without exposing local runtime paths or errors', async () => {
    const status = await checkComputerUseStatus({
      pathExists: async () => false,
      detectPythonRuntime: async () => ({
        installed: true,
        version: '3.12.0',
        path: '/private/runtime/python3',
        command: 'python3',
        prefixArgs: [],
        source: 'system',
        error: null,
      }),
    }) as {
      python: Record<string, unknown>
      venv: Record<string, unknown>
      dependencies: Record<string, unknown>
    }
    expect(status.python.installed).toEqual(expect.any(Boolean))
    expect(status.python).toHaveProperty('version')
    expect(status.venv).toEqual({ created: expect.any(Boolean) })
    expect(status.dependencies).toEqual({ installed: expect.any(Boolean) })
    expect(JSON.stringify(status)).not.toMatch(/(?:path|error|source)/i)
  })

  it('rejects persistent authorization writes without a desktop capability', async () => {
    const putRes = await callAuthorizedApps('PUT', {
      enabled: false,
      pythonPath: '/tmp/attacker-python',
      authorizedApps: [{ bundleId: 'com.attacker.app', displayName: 'Attacker' }],
      grantFlags: { clipboardRead: true, clipboardWrite: true, systemKeyCombos: true },
    })

    expect(putRes.status).toBe(403)
    expect(await putRes.json()).toMatchObject({
      error: 'COMPUTER_USE_PERSISTENCE_FORBIDDEN',
    })
  })

  it('does not expose the retired persistent allowlist API', async () => {
    const getRes = await callAuthorizedApps('GET')

    expect(getRes.status).toBe(410)
  })
})

describe('runPipInstallWithFallback', () => {
  it('builds a clear unsupported Python version step for setup', async () => {
    expect(getUnsupportedPythonVersionStep('3.8.18')).toEqual({
      name: 'python_version',
      ok: false,
      message: 'Computer Use 需要 Python >= 3.9，当前版本为 3.8.18',
    })
    expect(getUnsupportedPythonVersionStep('3.9.19')).toBeNull()
  })

  it('installs setup dependencies by upgrading pip before requirements', async () => {
    const calls: string[] = []

    const result = await installSetupDependencies(
      'python',
      '/tmp/requirements.txt',
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        return { ok: true, stdout: args.includes('-r') ? 'deps' : 'pip', stderr: '', code: 0 }
      },
    )

    expect(result.stdout).toBe('deps')
    expect(calls).toEqual([
      'python -m pip install --upgrade pip',
      'python -m pip install -r /tmp/requirements.txt',
    ])
  })

  it('tries the mirror first and falls back to the default PyPI index', async () => {
    const calls: string[] = []
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (cmd, args) => {
        calls.push(`${cmd} ${args.join(' ')}`)
        if (args.includes('-i')) {
          return { ok: false, stdout: '', stderr: 'mirror unavailable', code: 1 }
        }
        return { ok: true, stdout: 'installed', stderr: '', code: 0 }
      },
    )

    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('installed')
    expect(calls).toEqual([
      'python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple/ --trusted-host pypi.tuna.tsinghua.edu.cn',
      'python -m pip install -r requirements.txt',
    ])
  })

  it('returns the first failure when every pip index attempt fails', async () => {
    const result = await runPipInstallWithFallback(
      'python',
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      async (_cmd, args) => ({
        ok: false,
        stdout: '',
        stderr: args.includes('-i') ? 'mirror failed' : 'default failed',
        code: args.includes('-i') ? 1 : 2,
      }),
    )

    expect(result).toEqual({ ok: false, stdout: '', stderr: 'mirror failed', code: 1 })
  })
})
