import { readFileSync } from 'node:fs'

export type StaticDeploymentEnvironment = Record<string, string>

function valueWithoutQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * Parse only the EnvironmentFile subset used by the production services. This
 * never sources a file, expands variables, executes shell syntax or prints values.
 */
export function readStaticDeploymentEnvironment(path: string): StaticDeploymentEnvironment {
  const contents = readFileSync(path, 'utf8')
  const environment: StaticDeploymentEnvironment = {}
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) throw new Error(`line ${index + 1} is not KEY=VALUE`)
    environment[match[1]!] = valueWithoutQuotes(match[2]!)
  }
  return environment
}

export function currentDeploymentEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): StaticDeploymentEnvironment {
  const environment: StaticDeploymentEnvironment = {}
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === 'string') environment[name] = value
  }
  return environment
}
