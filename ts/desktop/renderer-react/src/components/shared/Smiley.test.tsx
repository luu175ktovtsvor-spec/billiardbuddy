import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Smiley } from './Smiley'

test('Smiley renders the established blue gradient with a visible white face', () => {
  const html = renderToStaticMarkup(<Smiley size={20} />)

  expect(html).toContain('var(--color-smiley-a)')
  expect(html).toContain('var(--color-smiley-b)')
  expect(html).toContain('linearGradient')
  expect(html).toContain('fill="#ffffff"')
  expect(html).toContain('stroke="#ffffff"')
})
