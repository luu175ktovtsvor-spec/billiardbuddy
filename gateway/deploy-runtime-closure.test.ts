import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('gateway deployment ships the current runtime closure without retired Qwen code', () => {
  const deploy = readFileSync(resolve(import.meta.dir, 'deploy.sh'), 'utf8')

  for (const source of [
    'app.ts',
    'authority.ts',
    'mimoChat.ts',
    'deepseekChat.ts',
    'modelCapacity.ts',
    'visionBridge.ts',
    'transcription.ts',
    'usageBudget.ts',
    'providerRegistry.ts',
    'validate-auth-env.ts',
  ]) {
    expect(deploy).toContain(`/tmp/${source}`)
  }
  expect(deploy).toContain('$APPDIR/auth/authority.ts')
  expect(deploy).toContain('chmod 700 "$APPDIR"')
  expect(deploy).toContain('loadtestCredentials.ts real-loadtest.ts vision-real-loadtest.ts image-real-loadtest.ts mimo-mixed-real-loadtest.ts')
  expect(deploy).toContain('受控压测工具必须整组上传')
  expect(deploy).not.toContain('/tmp/qwenChat.ts')
  expect(deploy).toContain('rm -f "$APPDIR/qwenChat.ts" "$APPDIR/webSearch.ts"')
})
