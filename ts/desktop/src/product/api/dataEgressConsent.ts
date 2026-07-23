import {
  REMOTE_DATA_EGRESS_POLICY_REVISION,
  type RemoteDataEgressStatus,
} from '../../../../shared/product/dataEgress'
import { productApi } from './client'

const PATH = '/api/product/data-egress-consent'

export const productDataEgressConsentApi = {
  status: () => productApi.get<RemoteDataEgressStatus>(PATH),
  grant: () => productApi.post<RemoteDataEgressStatus>(PATH, {
    policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
    acknowledged: true,
  }),
  revoke: () => productApi.delete<RemoteDataEgressStatus>(PATH),
}
