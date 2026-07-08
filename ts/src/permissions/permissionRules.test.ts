import { expect, test } from 'bun:test'
import {
  parseToolListFromCLI,
  permissionRuleValueFromString,
  shellCommandAllowedByPermissionRules,
  shellCommandMatchesPermissionRule,
  splitShellCommandsForPermission,
  stripSafeShellWrappers,
} from './permissionRules'

test('permissionRuleValueFromString parses escaped parentheses and wildcard tool-wide rules', () => {
  expect(permissionRuleValueFromString('Bash')).toEqual({ toolName: 'Bash' })
  expect(permissionRuleValueFromString('Bash(*)')).toEqual({ toolName: 'Bash' })
  expect(permissionRuleValueFromString('Bash(node -e "run\\(\\)")')).toEqual({
    toolName: 'Bash',
    ruleContent: 'node -e "run()"',
  })
})

test('parseToolListFromCLI keeps spaces and commas inside rule parentheses', () => {
  expect(parseToolListFromCLI(['Read Bash(git status:*)', 'Bash(node -e "a,b")'])).toEqual([
    'Read',
    'Bash(git status:*)',
    'Bash(node -e "a,b")',
  ])
})

test('shellCommandMatchesPermissionRule supports exact prefix and wildcard syntax', () => {
  expect(shellCommandMatchesPermissionRule('git status --short', 'git:*')).toBe(true)
  expect(shellCommandMatchesPermissionRule('git status --short', 'git status *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('git status', 'git status *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('git status --short', 'git status')).toBe(false)
  expect(shellCommandMatchesPermissionRule('echo \\*', 'echo \\*')).toBe(true)
  expect(shellCommandMatchesPermissionRule('echo *', 'echo \\*')).toBe(false)
  expect(shellCommandMatchesPermissionRule('echo ok', 'echo \\*')).toBe(false)
})

test('shell permission matching normalizes safe env vars and wrappers', () => {
  expect(stripSafeShellWrappers('NODE_ENV=test npm run build')).toBe('npm run build')
  expect(stripSafeShellWrappers('PATH=/tmp npm run build')).toBe('PATH=/tmp npm run build')
  expect(stripSafeShellWrappers('timeout 10 npm run build')).toBe('npm run build')
  expect(stripSafeShellWrappers('timeout -k$(id) 10 npm run build')).toBe('timeout -k$(id) 10 npm run build')
  expect(stripSafeShellWrappers('nohup NODE_ENV=test npm run build')).toBe('NODE_ENV=test npm run build')

  expect(shellCommandMatchesPermissionRule('NODE_ENV=test npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('PATH=/tmp npm run build', 'npm run *')).toBe(false)
  expect(shellCommandMatchesPermissionRule('timeout 10 npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('timeout -k$(id) 10 npm run build', 'npm run *')).toBe(false)
})

test('shell permission matching checks compound commands per subcommand', () => {
  expect(splitShellCommandsForPermission('git status && node -e "console.log(1 && 2)" | head')).toEqual([
    'git status',
    'node -e "console.log(1 && 2)"',
    'head',
  ])
  expect(shellCommandMatchesPermissionRule('git status && curl https://example.com', 'git:*')).toBe(false)
  expect(shellCommandAllowedByPermissionRules('git status && curl https://example.com', ['git:*'])).toBe(false)
  expect(shellCommandAllowedByPermissionRules('git status && printf ok', ['git:*', 'printf:*'])).toBe(true)
  expect(shellCommandAllowedByPermissionRules('node -e "console.log(1 && 2)"', ['node:*'])).toBe(true)
})
