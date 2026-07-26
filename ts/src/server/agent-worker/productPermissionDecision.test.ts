import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { decideProductToolPermission } from './productPermissionDecision.js'
import { buildProductTool, emptyProductToolPermissionContext, type ProductTool, type ProductToolContext } from './productTool.js'

function envelope(approval_policy: PermissionExecutionEnvelope['approval_policy']): PermissionExecutionEnvelope {
  return {
    version: 1,
    mode: 'policy_bound',
    sandbox_profile: approval_policy === 'never' ? 'unrestricted' : 'workspace',
    approval_policy,
    reviewer: approval_policy === 'never' ? 'none' : approval_policy === 'automatic_reviewer' ? 'automatic' : 'user',
    network_scope: approval_policy === 'never' ? 'unrestricted' : 'approved',
    digest: 'permission-test',
  }
}

function networkDeniedEnvelope(): PermissionExecutionEnvelope {
  return {
    version: 1,
    mode: 'legacy_deferred',
    sandbox_profile: 'workspace',
    approval_policy: 'user_reviewer',
    reviewer: 'user',
    network_scope: 'denied',
    digest: 'permission-test',
  }
}

function context(): ProductToolContext {
  return {
    abortController: new AbortController(),
    permissionContext: emptyProductToolPermissionContext(),
    options: { commands: [], mainLoopModel: 'deepseek-v4-flash', tools: [], thinkingConfig: { type: 'adaptive' } },
    messages: [],
  }
}

function tool(input: { readOnly: boolean; openWorld?: boolean; destructive?: boolean; mcp?: boolean; name?: string }): ProductTool {
  return buildProductTool({
    name: input.name ?? 'Read',
    maxResultSizeChars: 1_000,
    inputSchema: z.object({ value: z.string() }),
    checkPermissions: async () => ({ behavior: 'passthrough', message: 'review' }),
    isReadOnly: () => input.readOnly,
    isOpenWorld: () => input.openWorld ?? false,
    isDestructive: () => input.destructive ?? false,
    isMcp: input.mcp,
    async description() { return 'test' },
    async call() { return { data: 'test' } },
    mapToolResultToToolResultBlockParam(data, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content: String(data) } },
  })
}

describe('Product Host permission decision', () => {
  test('automatic reviewer allows only conservative local reads', async () => {
    await expect(decideProductToolPermission(envelope('automatic_reviewer'), tool({ readOnly: true }), { value: 'x' }, context()))
      .resolves.toMatchObject({ behavior: 'allow' })
    await expect(decideProductToolPermission(envelope('automatic_reviewer'), tool({ readOnly: false }), { value: 'x' }, context()))
      .resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('write_boundary') })
    await expect(decideProductToolPermission(envelope('automatic_reviewer'), tool({ readOnly: true, openWorld: true }), { value: 'x' }, context()))
      .resolves.toMatchObject({ behavior: 'deny', message: expect.stringContaining('data_egress') })
  })

  test('user reviewer does not silently allow MCP reads', async () => {
    await expect(decideProductToolPermission(envelope('user_reviewer'), tool({ readOnly: true, mcp: true }), { value: 'x' }, context()))
      .resolves.toMatchObject({ behavior: 'ask' })
  })

  test('frozen network denial blocks every open-world tool before user review', async () => {
    for (const name of ['WebFetch', 'WebSearch', 'RemotePluginTool']) {
      await expect(decideProductToolPermission(
        networkDeniedEnvelope(),
        tool({ readOnly: true, openWorld: true, name }),
        { value: 'x' },
        context(),
      )).resolves.toMatchObject({ behavior: 'deny', message: 'Network access is disabled for this Turn' })
    }
  })
})
