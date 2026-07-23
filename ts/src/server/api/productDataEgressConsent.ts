import { REMOTE_DATA_EGRESS_POLICY_REVISION } from '../../../shared/product/dataEgress.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import {
  remoteDataEgressConsentService,
  type RemoteDataEgressConsentService,
} from '../services/remoteDataEgressConsent.js'

function apiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if ((error as Error)?.message === 'INSTALLATION_IDENTITY_UNAVAILABLE') {
    return new ApiError(503, '安装身份不可用，远程能力已停止', 'REMOTE_DATA_EGRESS_UNAVAILABLE')
  }
  if ((error as Error)?.message === 'CONSENT_ACKNOWLEDGEMENT_INVALID') {
    return new ApiError(400, '数据出境确认已过期，请重新查看', 'REMOTE_DATA_EGRESS_INVALID')
  }
  return new ApiError(503, '暂时无法保存数据出境设置', 'REMOTE_DATA_EGRESS_UNAVAILABLE')
}

export async function handleProductDataEgressConsentApi(
  req: Request,
  segments: string[],
  service: Pick<RemoteDataEgressConsentService, 'status' | 'grant' | 'revoke'> = remoteDataEgressConsentService,
): Promise<Response> {
  try {
    if (segments[3]) throw ApiError.notFound('未知数据出境设置资源')
    if (req.method === 'GET') return Response.json(await service.status())
    if (req.method === 'DELETE') return Response.json(await service.revoke())
    if (req.method !== 'POST') throw new ApiError(405, '当前操作暂不支持', 'METHOD_NOT_ALLOWED')
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body || Object.keys(body).some(key => !['policy_revision', 'acknowledged'].includes(key))) {
      throw new ApiError(400, '数据出境确认无效', 'REMOTE_DATA_EGRESS_INVALID')
    }
    if (body.policy_revision !== REMOTE_DATA_EGRESS_POLICY_REVISION || body.acknowledged !== true) {
      throw new ApiError(400, '数据出境确认已过期，请重新查看', 'REMOTE_DATA_EGRESS_INVALID')
    }
    return Response.json(await service.grant(body))
  } catch (error) {
    return errorResponse(apiError(error))
  }
}
