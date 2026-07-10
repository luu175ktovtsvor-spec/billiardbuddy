import { expect, test } from 'bun:test'
import {
  MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
  parseToolListFromCLI,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  shellCommandAllowedByPermissionRules,
  shellCommandMatchesDenyOrAskRule,
  shellCommandMatchesPermissionRule,
  splitShellCommandsForPermission,
  stripAllLeadingEnvVars,
  stripSafeShellWrappers,
} from './permissionRules'

test('permissionRuleValueFromString parses escaped parentheses and wildcard tool-wide rules', () => {
  expect(permissionRuleValueFromString('Bash')).toEqual({ toolName: 'Bash' })
  expect(permissionRuleValueFromString('Bash(*)')).toEqual({ toolName: 'Bash' })
  expect(permissionRuleValueFromString('Bash(node -e "run\\(\\)")')).toEqual({
    toolName: 'Bash',
    ruleContent: 'node -e "run()"',
  })
  expect(permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'node -e "run()"' })).toBe('Bash(node -e "run\\(\\)")')
  expect(permissionRuleValueFromString(permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'echo "a\\\\b"' }))).toEqual({
    toolName: 'Bash',
    ruleContent: 'echo "a\\\\b"',
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
  expect(stripSafeShellWrappers('stdbuf -o 0 npm run build')).toBe('npm run build')
  expect(stripSafeShellWrappers('stdbuf --output=0 npm run build')).toBe('npm run build')
  expect(stripSafeShellWrappers('nohup NODE_ENV=test npm run build')).toBe('NODE_ENV=test npm run build')
  expect(stripSafeShellWrappers('nohup NODE_ENV=test timeout 5 npm run build')).toBe('NODE_ENV=test timeout 5 npm run build')

  expect(shellCommandMatchesPermissionRule('NODE_ENV=test npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('PATH=/tmp npm run build', 'npm run *')).toBe(false)
  expect(shellCommandMatchesPermissionRule('timeout 10 npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('stdbuf -o 0 npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('stdbuf --output=0 npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('nohup NODE_ENV=test timeout 5 npm run build', 'npm run *')).toBe(true)
  expect(shellCommandMatchesPermissionRule('nohup PATH=/tmp timeout 5 npm run build', 'npm run *')).toBe(false)
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
  const tooMany = Array.from({ length: MAX_SUBCOMMANDS_FOR_SECURITY_CHECK + 1 }, () => 'printf ok').join(' && ')
  expect(shellCommandAllowedByPermissionRules(tooMany, ['printf:*'])).toBe(false)
})

test('stripAllLeadingEnvVars peels every leading env var regardless of safe-list', () => {
  expect(stripAllLeadingEnvVars('FOO=bar rm x')).toBe('rm x')
  expect(stripAllLeadingEnvVars('PATH=/tmp npm run build')).toBe('npm run build')
  expect(stripAllLeadingEnvVars('A=1 B=2 rm x')).toBe('rm x')
  expect(stripAllLeadingEnvVars('FOO="a b" rm x')).toBe('rm x')
  // SECURITY: command substitution in the value is NOT stripped (would hide expansion)
  expect(stripAllLeadingEnvVars('FOO=$(id) rm x')).toBe('FOO=$(id) rm x')
  expect(stripAllLeadingEnvVars('rm x')).toBe('rm x')
})

test('shellCommandMatchesDenyOrAskRule matches denied subcommands inside compound/wrappers (cc-aligned)', () => {
  // Core bug: prefix deny rule must catch the denied subcommand of a compound command.
  expect(shellCommandMatchesDenyOrAskRule('true && rm x', 'rm:*')).toBe(true)
  expect(shellCommandMatchesDenyOrAskRule('echo hi; rm -rf build', 'rm:*')).toBe(true)
  expect(shellCommandMatchesDenyOrAskRule('echo hi | xargs rm foo', 'rm:*')).toBe(true)
  // Exec-wrapper / env-var prefixes on a single command must still hit deny.
  expect(shellCommandMatchesDenyOrAskRule('env FOO=1 rm x', 'rm:*')).toBe(true)
  expect(shellCommandMatchesDenyOrAskRule('sudo rm x', 'rm:*')).toBe(true)
  expect(shellCommandMatchesDenyOrAskRule('sudo -k rm x', 'rm:*')).toBe(true)
  expect(shellCommandMatchesDenyOrAskRule('doas rm x', 'rm:*')).toBe(true)
  // Aggressive env stripping: even non-safe env vars can't shield a denied command.
  expect(shellCommandMatchesDenyOrAskRule('PATH=/tmp npm run build', 'npm run:*')).toBe(true)
  // Layered wrappers + env vars resolve to the wrapped command.
  expect(shellCommandMatchesDenyOrAskRule('nohup FOO=bar sudo timeout 5 rm x', 'rm:*')).toBe(true)
  // Exact rule on the whole compound string still matches.
  expect(shellCommandMatchesDenyOrAskRule('true && rm x', 'true && rm x')).toBe(true)
  // Wildcard rule matches a subcommand after split.
  expect(shellCommandMatchesDenyOrAskRule('git status && curl https://evil.com', 'curl *')).toBe(true)

  // Non-regression: rules that shouldn't match still don't.
  expect(shellCommandMatchesDenyOrAskRule('git status --short', 'rm:*')).toBe(false)
  expect(shellCommandMatchesDenyOrAskRule('git status', 'npm publish:*')).toBe(false)
  // Word boundary: envsubst / remove must not be mistaken for env / rm.
  expect(shellCommandMatchesDenyOrAskRule('envsubst < tpl', 'rm:*')).toBe(false)
  expect(shellCommandMatchesDenyOrAskRule('remove x', 'rm:*')).toBe(false)
})
