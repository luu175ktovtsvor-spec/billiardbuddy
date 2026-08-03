import { mediaSafeError } from '../../../shared/contracts/media'
import type { ImageWorkbenchIpcResponse } from '../../../shared/contracts/imageWorkbenchPreload'
import { ElectronImageActionError } from '../services/imageActions'

/**
 * Electron rejects lose custom error fields at the renderer boundary. Image
 * commands instead return an explicit, shared error envelope for expected
 * public media failures.
 */
export async function imageWorkbenchIpcResponse<Value>(
  action: () => Value | Promise<Value>,
): Promise<ImageWorkbenchIpcResponse<Value>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    const code = error instanceof ElectronImageActionError
      ? error.code
      : 'MEDIA_TEMPORARILY_UNAVAILABLE'
    return { ok: false, error: mediaSafeError(code) }
  }
}
