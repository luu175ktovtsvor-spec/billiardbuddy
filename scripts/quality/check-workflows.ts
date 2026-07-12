#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '../..')
const errors: string[] = []

async function workflow(name: string): Promise<{ text: string; data: Record<string, unknown> }> {
  const text = await readFile(path.join(root, '.github/workflows', name), 'utf8')
  return { text, data: Bun.YAML.parse(text) as Record<string, unknown> }
}

const quality = await workflow('ts-harness-ci.yml')
const qualityOn = quality.data.on as { push?: { branches?: string[] }; pull_request?: unknown } | undefined
if (!qualityOn?.push?.branches?.includes('main')) errors.push('ts-harness-ci.yml: push 必须监听 main')
if (!qualityOn || !('pull_request' in qualityOn)) errors.push('ts-harness-ci.yml: 必须监听 pull_request')
if (!quality.text.includes('bash scripts/quality_gate.sh')) errors.push('ts-harness-ci.yml: 必须执行统一质量门')
if (!quality.text.includes('xvfb-run --auto-servernum bun run e2e:desktop')) errors.push('ts-harness-ci.yml: 必须在 Linux 虚拟显示器运行桌面 E2E')
if (!quality.text.includes('ts/test-results/desktop-e2e/')) errors.push('ts-harness-ci.yml: 必须上传桌面 E2E 证据')
if (!quality.text.includes('if: failure()') || !quality.text.includes('continue-on-error: true')) errors.push('ts-harness-ci.yml: E2E 证据上传必须仅在失败时尽力执行，不得覆盖测试结论')

const windows = await workflow('desktop-build-win.yml')
for (const retired of ['working-directory: web', 'working-directory: server', 'working-directory: desktop']) {
  if (windows.text.includes(retired)) errors.push(`desktop-build-win.yml: 仍引用退役目录 ${retired.split(': ')[1]}`)
}
for (const required of ['bun run ui:build', 'bun run desktop:build', 'bun run build:sidecar', '--publish never']) {
  if (!windows.text.includes(required)) errors.push(`desktop-build-win.yml: 缺少 ${required}`)
}
if (/\bscp\b|DEPLOY_SSH|desktop-updates/.test(windows.text)) errors.push('desktop-build-win.yml: 当前更新渠道未完成，不得自动上传用户更新目录')

if (errors.length > 0) {
  console.error(`GitHub 工作流检查失败（${errors.length} 项）:\n${errors.join('\n')}`)
  process.exit(1)
}
console.log('GitHub 工作流检查通过')
