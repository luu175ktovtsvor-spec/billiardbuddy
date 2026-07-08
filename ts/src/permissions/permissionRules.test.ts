import { expect, test } from 'bun:test'
import {
  parseToolListFromCLI,
  permissionRuleValueFromString,
  shellCommandMatchesPermissionRule,
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
