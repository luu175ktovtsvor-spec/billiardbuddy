const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'PWD', 'OLDPWD',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'LOCALAPPDATA',
  'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
])

const SAFE_PREFIXES = ['LC_', 'GIT_AUTHOR_', 'GIT_COMMITTER_']
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function validValue(value: string): boolean {
  return !value.includes('\0')
}

/**
 * Build an environment for model-triggered child processes. Product/server
 * credentials stay in the Host; only basic process context and values named
 * explicitly by the relevant extension are delegated.
 */
export function productSubprocessEnvironment(
  configured: Record<string, string> = {},
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || !validValue(value)) continue
    if (SAFE_ENVIRONMENT_KEYS.has(name) || SAFE_PREFIXES.some(prefix => name.startsWith(prefix))) {
      output[name] = value
    }
  }
  for (const [name, value] of Object.entries(configured)) {
    if (!ENVIRONMENT_NAME.test(name) || !validValue(value)) {
      throw new Error('PRODUCT_SUBPROCESS_ENVIRONMENT_INVALID')
    }
    output[name] = value
  }
  return output
}
