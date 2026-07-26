import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it } from 'vitest'

import { safeStartupErrorCode, StartupErrorView } from './StartupErrorView'

describe('safeStartupErrorCode', () => {
  it('turns arbitrary startup output into one stable product error code', () => {
    expect(safeStartupErrorCode('desktop server did not start listening on 127.0.0.1:57608')).toBe('BB_STARTUP_FAILED')
    expect(safeStartupErrorCode('BB_STARTUP_FAILED')).toBe('BB_STARTUP_FAILED')
  })
})

describe('StartupErrorView', () => {
  it('does not render or copy raw startup stderr and paths', () => {
    const privateOutput = 'startup failed at /Users/test/.BilliardBuddy/runtime with [stderr] gateway rejected token'
    render(<StartupErrorView error={privateOutput} />)

    expect(screen.getByText('本地服务启动失败')).toBeInTheDocument()
    expect(screen.getByText('错误编号：BB_STARTUP_FAILED')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('/Users/test/.BilliardBuddy')
    expect(document.body.textContent).not.toContain('gateway rejected token')
    expect(screen.queryByRole('button', { name: /复制诊断信息/i })).toBeNull()
  })
})
