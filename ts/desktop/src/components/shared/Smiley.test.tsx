import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Smiley } from './Smiley'

describe('Smiley', () => {
  it('keeps the established blue gradient and white face', () => {
    const html = renderToStaticMarkup(<Smiley size={20} />)

    expect(html).toContain('var(--color-smiley-a)')
    expect(html).toContain('var(--color-smiley-b)')
    expect(html).toContain('linearGradient')
    expect(html).toContain('fill="#ffffff"')
    expect(html).toContain('stroke="#ffffff"')
  })
})
