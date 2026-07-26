import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { runWithProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import { createProductHarnessLifecycleHookHost } from './productLifecycleHooks.js'
import type { ProductHookSnapshot } from './productHookSnapshot.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

const envelope: PermissionExecutionEnvelope = {
  version: 1,
  mode: 'policy_bound',
  sandbox_profile: 'unrestricted',
  approval_policy: 'never',
  reviewer: 'none',
  network_scope: 'unrestricted',
  digest: 'hook-test',
}

function snapshot(hooks: ProductHookSnapshot['hooks']): ProductHookSnapshot {
  return { hooks, digest: 'test', sourceCount: 1, matcherCount: 1, commandCount: 1 }
}

describe('Product lifecycle Hooks', () => {
  test('PreToolUse honors matcher, input condition, and once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-hook-'))
    roots.push(root)
    const log = path.join(root, 'hook.log')
    const host = createProductHarnessLifecycleHookHost({
      cwd: root,
      snapshot: snapshot({ PreToolUse: [{
        matcher: 'R*',
        hooks: [{ type: 'command', command: `printf x >> ${JSON.stringify(log)}`, if: 'Read(*foo.txt*)', once: true }],
      }] }),
    })
    const signal = new AbortController().signal

    await runWithProductPermissionEnvelope(envelope, () => host.preTool({ toolName: 'Read', toolInput: { file_path: 'foo.txt' }, toolUseId: 'one', signal }))
    await runWithProductPermissionEnvelope(envelope, () => host.preTool({ toolName: 'Read', toolInput: { file_path: 'foo.txt' }, toolUseId: 'two', signal }))
    await runWithProductPermissionEnvelope(envelope, () => host.preTool({ toolName: 'Read', toolInput: { file_path: 'bar.txt' }, toolUseId: 'three', signal }))

    expect(await fs.readFile(log, 'utf8')).toBe('x')
  })

  test('a failing command Hook blocks the tool call', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-hook-'))
    roots.push(root)
    const host = createProductHarnessLifecycleHookHost({
      cwd: root,
      snapshot: snapshot({ PreToolUse: [{ hooks: [{ type: 'command', command: 'printf denied >&2; exit 7' }] }] }),
    })

    const result = await runWithProductPermissionEnvelope(envelope, () => host.preTool({
      toolName: 'Write',
      toolInput: { file_path: 'result.txt' },
      toolUseId: 'blocked',
      signal: new AbortController().signal,
    }))

    expect(result).toEqual({ blocked: true, reason: 'denied' })
  })

  test('Prompt and Agent Hooks use the verified evaluator and fail closed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-hook-'))
    roots.push(root)
    const prompts: string[] = []
    const host = createProductHarnessLifecycleHookHost({
      cwd: root,
      snapshot: snapshot({ Stop: [{ hooks: [
        { type: 'prompt', prompt: 'verify $ARGUMENTS', once: true },
        { type: 'agent', prompt: 'review $ARGUMENTS' },
      ] }] }),
      evaluate: async prompt => {
        prompts.push(prompt)
        return prompt.startsWith('verify') ? { ok: true } : { ok: false, reason: 'review rejected' }
      },
    })
    const signal = new AbortController().signal
    const context = { abortController: new AbortController() } as never
    const stop = () => host.stop({ permissionMode: 'default', signal, context, messages: [] })

    expect(await stop()).toEqual({ blocked: true, reason: 'review rejected' })
    expect(await stop()).toEqual({ blocked: true, reason: 'review rejected' })
    expect(prompts.filter(prompt => prompt.startsWith('verify'))).toHaveLength(1)
    expect(prompts.filter(prompt => prompt.startsWith('review'))).toHaveLength(2)
  })

  test('asyncRewake detaches from the completed event signal and schedules a once Hook only once', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-hook-'))
    roots.push(root)
    const rewakes: Array<{ additionalContext?: string; reason?: string }> = []
    let resolve!: () => void
    const rewoke = new Promise<void>(next => { resolve = next })
    const host = createProductHarnessLifecycleHookHost({
      cwd: root,
      snapshot: snapshot({ PreToolUse: [{ hooks: [{
        type: 'command',
        command: `sleep 0.05; printf '%s' '{"systemMessage":"background evidence"}'`,
        asyncRewake: true,
        once: true,
      }] }] }),
      onAsyncRewake: value => { rewakes.push(value); resolve() },
    })
    const controller = new AbortController()
    const invoke = () => runWithProductPermissionEnvelope(envelope, () => host.preTool({ toolName: 'Read', toolInput: {}, toolUseId: 'async', signal: controller.signal }))
    await Promise.all([invoke(), invoke()])
    controller.abort()
    await rewoke
    await Bun.sleep(30)

    expect(rewakes).toEqual([{ event: 'PreToolUse', additionalContext: 'background evidence' }])
  })
})
