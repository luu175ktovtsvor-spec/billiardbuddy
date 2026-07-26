import { randomUUID } from 'node:crypto'
import type { ProductPrompt, ProductUserMessage } from '../../../shared/product/harnessMessages.js'

/** Minimal message constructor owned by the GUI Harness. */
export function createProductUserMessage(input: {
  content: ProductPrompt | import('../../../shared/product/harnessMessages.js').ProductToolResultBlock[]
  isMeta?: true
}): ProductUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: input.content || '(empty message)',
    },
    isMeta: input.isMeta,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
