/** Shared local Product API for settings and voice. Agent execution is Rust-only. */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { handleProductSettingsApi } from './productSettings.js'
import { handleProductVoiceApi } from './productVoice.js'

export async function handleProductControlApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  try {
    if (segments[2] === 'voice') {
      return await handleProductVoiceApi(req, segments)
    }

    if (segments[2] === 'settings') {
      return await handleProductSettingsApi(req, url, segments)
    }

    throw ApiError.notFound('未知产品资源')
  } catch (error) {
    return errorResponse(error)
  }
}
