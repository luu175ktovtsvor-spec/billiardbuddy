import { AsyncLocalStorage } from 'node:async_hooks'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'

const productPermissionRuntime = new AsyncLocalStorage<PermissionExecutionEnvelope>()

export function runWithProductPermissionEnvelope<T>(
  envelope: PermissionExecutionEnvelope,
  operation: () => T,
): T {
  return productPermissionRuntime.run(envelope, operation)
}

export function productSandboxIsUnrestricted(): boolean {
  return productPermissionRuntime.getStore()?.sandbox_profile === 'unrestricted'
}
