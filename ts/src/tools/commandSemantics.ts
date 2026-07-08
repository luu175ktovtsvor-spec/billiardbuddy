import { splitShellCommandsForPermission } from '../permissions/permissionRules'

export interface CommandSemanticResult {
  isError: boolean
  message?: string
}

type CommandSemantic = (exitCode: number, stdout: string, stderr: string) => CommandSemanticResult

const DEFAULT_SEMANTIC: CommandSemantic = exitCode => ({
  isError: exitCode !== 0,
  message: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

const COMMAND_SEMANTICS = new Map<string, CommandSemantic>([
  ['grep', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'No matches found' : undefined })],
  ['rg', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'No matches found' : undefined })],
  ['find', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Some directories were inaccessible' : undefined })],
  ['diff', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Files differ' : undefined })],
  ['test', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Condition is false' : undefined })],
  ['[', exitCode => ({ isError: exitCode >= 2, message: exitCode === 1 ? 'Condition is false' : undefined })],
])

export function interpretCommandResult(command: string, exitCode: number, stdout: string, stderr: string): CommandSemanticResult {
  const semantic = COMMAND_SEMANTICS.get(heuristicallyExtractBaseCommand(command)) ?? DEFAULT_SEMANTIC
  return semantic(exitCode, stdout, stderr)
}

function heuristicallyExtractBaseCommand(command: string): string {
  const segments = splitShellCommandsForPermission(command)
  const lastCommand = segments[segments.length - 1] ?? command
  return lastCommand.trim().split(/\s+/)[0] ?? ''
}
