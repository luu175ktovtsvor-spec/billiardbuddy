import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProductPrivacySettings } from './ProductPrivacySettings'

describe('ProductPrivacySettings', () => {
  it('states remote processing once without consent, billing or provider controls', () => {
    render(<ProductPrivacySettings />)
    expect(screen.getByText('远程处理说明')).toBeTruthy()
    expect(screen.getByText(/BilliardBuddy 的受管远程服务/)).toBeTruthy()
    expect(screen.getByText(/不会在每个回合或每次媒体操作前反复要求确认/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/同意并继续|撤销允许|付费操作/)
  })
})
