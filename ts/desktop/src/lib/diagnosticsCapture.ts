import React from 'react'
import {
  rawRecordDiagnosticEvent,
  type ClientDiagnosticEventType,
} from '../api/client'

let installed = false

export function installClientDiagnosticsCapture() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', () => {
    void reportClientError('client_window_error')
  })

  window.addEventListener('unhandledrejection', () => {
    void reportClientError('client_unhandled_rejection')
  })
}

export function reportReactError(error: unknown, errorInfo: React.ErrorInfo) {
  // The renderer must not send exception text, component stacks, browser URLs,
  // or user-agent data to the ordinary diagnostics endpoint.
  void error
  void errorInfo
  return reportClientError('client_react_error_boundary')
}

function reportClientError(type: ClientDiagnosticEventType) {
  return rawRecordDiagnosticEvent({
    type,
    severity: 'error',
  })
}
