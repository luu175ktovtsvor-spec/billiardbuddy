import {
  PRODUCT_TASK_RUN_FAILURE_CODES,
  type ProductTaskRunFailure,
  type ProductTaskRunFailureCode,
} from '../../../shared/product/taskEvents.js'

const RETRYABLE_FAILURES = new Set<ProductTaskRunFailureCode>([
  'task_capacity_limited',
  'task_model_unavailable',
  'task_network_unavailable',
  'task_model_response_invalid',
])

export function productTaskRunFailure(code: ProductTaskRunFailureCode): ProductTaskRunFailure {
  return { code, retryable: RETRYABLE_FAILURES.has(code) }
}

export function isProductTaskRunFailureCode(value: unknown): value is ProductTaskRunFailureCode {
  return typeof value === 'string' && (PRODUCT_TASK_RUN_FAILURE_CODES as readonly string[]).includes(value)
}

export function classifyProductTaskRunFailure(error: unknown): ProductTaskRunFailure {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : ''
  if (code === 'MODEL_CONFIGURATION_INVALID' || code === 'PRODUCT_GATEWAY_NOT_CONFIGURED') {
    return productTaskRunFailure('task_model_configuration')
  }
  if (code === 'PRODUCT_GATEWAY_HTTP_401' || code === 'PRODUCT_GATEWAY_HTTP_403') {
    return productTaskRunFailure('task_authentication')
  }
  if (code === 'PRODUCT_GATEWAY_HTTP_402' || code === 'PRODUCT_GATEWAY_HTTP_429') {
    return productTaskRunFailure('task_capacity_limited')
  }
  if (/^PRODUCT_GATEWAY_HTTP_(408|425|500|502|503|504)$/.test(code)) {
    return productTaskRunFailure('task_model_unavailable')
  }
  if (code === 'PRODUCT_GATEWAY_UNREACHABLE' || code === 'PRODUCT_MODEL_EMPTY_STREAM' || code === 'PRODUCT_WEB_SEARCH_STREAM_INTERRUPTED') {
    return productTaskRunFailure('task_network_unavailable')
  }
  if (code === 'CONTEXT_COMPACTION_FAILED' || code === 'PRODUCT_GATEWAY_HTTP_413' || code.startsWith('PRODUCT_PROMPT_CONTEXT_TOO_LARGE')) {
    return productTaskRunFailure('task_context_limit')
  }
  if (code.startsWith('PRODUCT_MODEL_') || code === 'PRODUCT_AGENT_LOOP_LIMIT' || code === 'PRODUCT_AGENT_TURN_INCOMPLETE' || code === 'PRODUCT_TOOL_RESULT_MISSING') {
    return productTaskRunFailure('task_model_response_invalid')
  }
  if (code.startsWith('PRODUCT_COMMAND_') || code.startsWith('PRODUCT_HOOK_') || code.startsWith('PRODUCT_STOP_HOOK_') || code.startsWith('PRODUCT_MCP_') || code.startsWith('PLUGIN_') || code.startsWith('SUBTASK_')) {
    return productTaskRunFailure('task_project_automation_failed')
  }
  if (code.startsWith('CHAT_ATTACHMENT_') || code.startsWith('CHAT_VIDEO_') || code === 'ATTACHMENT_COPY_INVALID') {
    return productTaskRunFailure('task_attachment_processing_failed')
  }
  if (code.startsWith('PRODUCT_PERMISSION_') || code.startsWith('PRODUCT_SHELL_SANDBOX_') || code === 'ENVELOPE_DENIED' || code === 'SCHEDULER_DENIED') {
    return productTaskRunFailure('task_execution_environment_failed')
  }
  return productTaskRunFailure('task_failed')
}
