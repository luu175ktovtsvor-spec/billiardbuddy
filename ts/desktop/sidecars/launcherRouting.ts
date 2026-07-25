export type SidecarMode = 'server' | 'cli' | 'browser-host'

const EXPLICIT_MODES = new Set<SidecarMode>(['server', 'cli', 'browser-host'])

export function resolveSidecarInvocation(
  rawArgs: string[],
  envAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): {
  mode: SidecarMode | null
  restArgs: string[]
  defaultAppRoot: string | null
} {
  const explicitMode = rawArgs[0]
  if (explicitMode && EXPLICIT_MODES.has(explicitMode as SidecarMode)) {
    return {
      mode: explicitMode as SidecarMode,
      restArgs: rawArgs.slice(1),
      defaultAppRoot: envAppRoot,
    }
  }

  if (rawArgs.some(arg => arg.startsWith('chrome-extension://'))) {
    return {
      mode: 'browser-host',
      restArgs: rawArgs,
      defaultAppRoot: envAppRoot,
    }
  }

  return {
    mode: null,
    restArgs: rawArgs,
    defaultAppRoot: envAppRoot,
  }
}

export function parseLauncherArgs(
  rawArgs: string[],
  defaultAppRoot: string | null = process.env.CLAUDE_APP_ROOT ?? null,
): { appRoot: string; args: string[] } {
  const nextArgs: string[] = []
  let appRoot: string | null = defaultAppRoot

  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--app-root') {
      appRoot = rawArgs[index + 1] ?? null
      index += 1
      continue
    }
    nextArgs.push(arg!)
  }

  if (!appRoot) {
    throw new Error('Missing --app-root for billiardbuddy-sidecar')
  }

  return { appRoot, args: nextArgs }
}
