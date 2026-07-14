import type { PermissionMode } from '../types/chat'

export function chatExecutionContext(permissionMode: PermissionMode, workspaceRoot: string | null) {
  return {
    permissionMode,
    full_disk_access: permissionMode === 'bypassPermissions',
    ...(workspaceRoot ? { working_dir: workspaceRoot } : {}),
  }
}
