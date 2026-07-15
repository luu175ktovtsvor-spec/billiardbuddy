import { canonicalPermissionMode } from '../../permissions/canonical'

export interface AgentPermissionPolicy {
  allowBypassPermissionsMode: boolean
  managedBypassDisabled: boolean
}

export function createAgentPermissionPolicyResolver(
  settings: { get(): Promise<{ allowBypassPermissionsMode: boolean }> },
  options: { enforcePermissionPolicy: boolean; managedBypassDisabled: boolean },
) {
  return async <T extends Record<string, unknown>>(body: T): Promise<T> => {
    const current = await settings.get()
    return applyAgentPermissionPolicy(body, {
      allowBypassPermissionsMode: options.enforcePermissionPolicy ? current.allowBypassPermissionsMode : true,
      managedBypassDisabled: options.managedBypassDisabled,
    }) as T
  }
}

/** 客户端选择会话档位，服务端策略决定它能否达到完全访问；全盘标志只从最终档位派生。 */
export function applyAgentPermissionPolicy(
  input: Record<string, unknown>,
  policy: AgentPermissionPolicy,
): Record<string, unknown> {
  const requested = canonicalPermissionMode(input.permissionMode ?? input.permission_mode)
  const bypassAllowed = policy.allowBypassPermissionsMode && !policy.managedBypassDisabled
  const permissionMode = requested === 'bypassPermissions' && !bypassAllowed ? 'default' : requested
  const output: Record<string, unknown> = {
    ...input,
    permissionMode,
    permission_mode: permissionMode,
    full_disk_access: permissionMode === 'bypassPermissions',
  }
  delete output.fullDiskAccess
  return output
}
