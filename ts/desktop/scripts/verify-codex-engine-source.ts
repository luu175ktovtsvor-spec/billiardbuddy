import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const expectedRevision = 'ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff'
const repositoryRoot = path.resolve(import.meta.dir, '../../..')
const engineRoot = path.join(repositoryRoot, 'third_party', 'codex-engine')
const enginePatches = [
  path.join(repositoryRoot, 'third_party', 'codex-engine-patches', '0001-host-managed-tools-only.patch'),
  path.join(repositoryRoot, 'third_party', 'codex-engine-patches', '0002-context-compaction-ledger.patch'),
] as const

function requireFile(relativePath: string): string {
  const file = path.join(engineRoot, relativePath)
  if (!existsSync(file)) throw new Error(`Codex Engine 源码缺少 ${relativePath}；请执行 git submodule update --init --recursive`)
  return readFileSync(file, 'utf8')
}

async function gitOutput(...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', engineRoot, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exit !== 0) throw new Error(`无法读取 Codex Engine Git 状态：${stderr.trim() || args.join(' ')}`)
  return stdout.trim()
}

async function main(): Promise<void> {
  const revision = await gitOutput('rev-parse', 'HEAD')
  if (revision !== expectedRevision) {
    throw new Error(`Codex Engine 提交不符合产品锁定版本：期望 ${expectedRevision}，实际 ${revision}`)
  }

  const license = requireFile('LICENSE')
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) {
    throw new Error('Codex Engine 缺少 Apache-2.0 LICENSE 文本')
  }
  const notice = requireFile('NOTICE')
  if (!notice.includes('OpenAI Codex')) throw new Error('Codex Engine NOTICE 未包含上游归属')

  const appServerManifest = requireFile('codex-rs/app-server/Cargo.toml')
  if (!/^name = "codex-app-server"$/m.test(appServerManifest)) {
    throw new Error('Codex Engine 源码缺少 codex-app-server 构建入口')
  }
  const providerInfo = requireFile('codex-rs/model-provider-info/src/lib.rs')
  if (!providerInfo.includes('pub enum WireApi') || !providerInfo.includes('Responses')) {
    throw new Error('Codex Engine 模型协议基线与预期不一致')
  }
  if (!providerInfo.includes('CHAT_WIRE_API_REMOVED_ERROR')) {
    throw new Error('Codex Engine 未明确标记 Chat wire API 限制；模型桥设计需要重新复核')
  }

  const hostManagedToolsPatch = readFileSync(enginePatches[0], 'utf8')
  if (!hostManagedToolsPatch.includes('host_managed_tools_only') || !hostManagedToolsPatch.includes('item/tool/call')) {
    throw new Error('Codex Engine 宿主工具补丁内容不完整')
  }
  const contextCompactionPatch = readFileSync(enginePatches[1], 'utf8')
  if (!contextCompactionPatch.includes('ContextCompaction') || !contextCompactionPatch.includes('input_tokens') || !contextCompactionPatch.includes('summary')) {
    throw new Error('Codex Engine 上下文压缩补丁内容不完整')
  }
  for (const patch of enginePatches) await gitOutput('apply', '--check', patch)

  console.log(`[codex-engine] source lock passed: ${revision}`)
  console.log('[codex-engine] app server, Apache-2.0 NOTICE, host-managed-tools and context-compaction patches verified; Chat must enter through the BilliardBuddy Responses bridge.')
}

await main()
