import { productCompactThreshold, resolveProductTextModel } from './productGatewayRuntime.js'
import type { ProductAgentHarnessModelPolicyPort } from '../agent-worker/agentHarnessPorts.js'

export const productAgentHarnessModelPolicyPort: ProductAgentHarnessModelPolicyPort = {
  resolve: resolveProductTextModel,
  compactThreshold: productCompactThreshold,
}
