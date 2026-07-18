import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ThinkingBlock } from './ThinkingBlock'
import { useSettingsStore } from '../../stores/settingsStore'

describe('ThinkingBlock', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'zh' })
  })

  afterEach(() => {
    cleanup()
    useSettingsStore.setState({ locale: 'zh' })
  })

  it('shows the in-progress label while thinking is active', () => {
    render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByText('思考中')).toBeInTheDocument()
    expect(screen.queryByText('reasoning...')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('removes the thinking row once thinking has completed', () => {
    const { container } = render(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('defaults to not exposing completed thinking', () => {
    const { container } = render(<ThinkingBlock content="reasoning..." />)
    expect(container).toBeEmptyDOMElement()
  })

  it('localizes the active label in English without retaining completed reasoning', () => {
    useSettingsStore.setState({ locale: 'en' })
    const { container, rerender } = render(<ThinkingBlock content="reasoning..." isActive />)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    rerender(<ThinkingBlock content="reasoning..." isActive={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
