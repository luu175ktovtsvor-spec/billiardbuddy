import type { ErrorInfo } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rawRecordDiagnosticEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../api/client', () => ({
  rawRecordDiagnosticEvent: rawRecordDiagnosticEventMock,
}))

import { reportReactError } from './diagnosticsCapture'

describe('diagnosticsCapture', () => {
  beforeEach(() => {
    rawRecordDiagnosticEventMock.mockClear()
  })

  it('reports React failures as a safe category without message, stack, URL, or component details', async () => {
    const error = new Error('provider failed at /private/app.ts?token=secret')
    error.stack = 'Error: provider failed\n    at /private/app.ts:12:3'
    const errorInfo = {
      componentStack: '\n    at SensitiveComponent (/private/SensitiveComponent.tsx:8:2)',
    } as ErrorInfo

    await reportReactError(error, errorInfo)

    expect(rawRecordDiagnosticEventMock).toHaveBeenCalledWith({
      type: 'client_react_error_boundary',
      severity: 'error',
    })
    expect(JSON.stringify(rawRecordDiagnosticEventMock.mock.calls)).not.toContain('/private/app.ts')
    expect(JSON.stringify(rawRecordDiagnosticEventMock.mock.calls)).not.toContain('token=secret')
    expect(JSON.stringify(rawRecordDiagnosticEventMock.mock.calls)).not.toContain('SensitiveComponent')
  })
})
