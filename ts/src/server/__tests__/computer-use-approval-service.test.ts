import { describe, expect, test } from 'bun:test'

import type {
  CuPermissionRequest,
  CuPermissionResponse,
} from '../../vendor/computer-use-mcp/types.js'
import { ComputerUseApprovalService } from '../services/computerUseApprovalService.js'

function makeRequest(requestId: string): CuPermissionRequest {
  return {
    requestId,
    reason: 'Edit the active document',
    apps: [{
      requestedName: 'Editor',
      resolved: {
        bundleId: 'com.example.Editor',
        displayName: 'Editor',
        path: '/Applications/Editor.app',
      },
      isSentinel: false,
      alreadyGranted: false,
      proposedTier: 'full',
    }],
    requestedFlags: { clipboardRead: true },
    screenshotFiltering: 'native',
  }
}

function makeResponse(overrides: Partial<CuPermissionResponse> = {}): CuPermissionResponse {
  return {
    granted: [{
      bundleId: 'com.example.Editor',
      displayName: 'Editor',
      grantedAt: 0,
      tier: 'full',
    }],
    denied: [],
    flags: {
      clipboardRead: true,
      clipboardWrite: false,
      systemKeyCombos: false,
    },
    userConsented: true,
    ...overrides,
  }
}

describe('ComputerUseApprovalService', () => {
  test('projects approval prompts without local paths or icon data', async () => {
    const privatePath = '/Users/test/private/Editor.app'
    const privateIcon = 'data:image/png;base64,private-icon-payload'
    const sent: unknown[] = []
    const request = makeRequest('request-projection')
    request.apps[0]!.resolved = {
      ...request.apps[0]!.resolved!,
      path: privatePath,
      iconDataUrl: privateIcon,
    }
    const service = new ComputerUseApprovalService((_sessionId, message) => {
      sent.push(message)
      return true
    })

    const approval = service.requestApproval('task-1', request)

    expect(sent).toEqual([{
      type: 'computer_use_permission_request',
      requestId: 'request-projection',
      request: {
        requestId: 'request-projection',
        reason: 'Edit the active document',
        apps: [{
          requestedName: 'Editor',
          resolved: {
            bundleId: 'com.example.Editor',
            displayName: 'Editor',
          },
          isSentinel: false,
          alreadyGranted: false,
          proposedTier: 'full',
        }],
        requestedFlags: { clipboardRead: true },
        screenshotFiltering: 'native',
      },
    }])
    expect(JSON.stringify(sent)).not.toContain(privatePath)
    expect(JSON.stringify(sent)).not.toContain(privateIcon)

    expect(service.resolveApproval('task-1', 'request-projection', makeResponse())).toBe(true)
    await expect(approval).resolves.toMatchObject({
      granted: [{ bundleId: 'com.example.Editor' }],
    })
  })

  test('rejects a forged bundle ID instead of granting it to the task', async () => {
    const service = new ComputerUseApprovalService(() => true)
    const approval = service.requestApproval('task-1', makeRequest('request-1'))

    const accepted = service.resolveApproval('task-1', 'request-1', makeResponse({
      granted: [{
        bundleId: 'com.attacker.HiddenTerminal',
        displayName: 'Attacker Terminal',
        grantedAt: 0,
        tier: 'full',
      }],
    }))

    expect(accepted).toBe(false)
    await expect(approval).resolves.toEqual({
      granted: [],
      denied: [],
      flags: {
        clipboardRead: false,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: false,
    })
  })

  test('keeps a request bound to its task and returns a canonical controlled grant', async () => {
    const service = new ComputerUseApprovalService(() => true)
    const approval = service.requestApproval('task-1', makeRequest('request-2'))

    expect(service.resolveApproval('other-task', 'request-2', makeResponse())).toBe(false)
    expect(service.resolveApproval('task-1', 'request-2', makeResponse({
      granted: [{
        bundleId: 'com.example.Editor',
        displayName: 'Forged display name',
        grantedAt: 0,
        tier: 'read',
      }],
    }))).toBe(true)

    await expect(approval).resolves.toEqual({
      granted: [{
        bundleId: 'com.example.Editor',
        displayName: 'Editor',
        grantedAt: expect.any(Number),
        tier: 'full',
      }],
      denied: [],
      flags: {
        clipboardRead: true,
        clipboardWrite: false,
        systemKeyCombos: false,
      },
      userConsented: true,
    })
  })
})
