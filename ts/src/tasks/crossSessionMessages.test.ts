import { expect, test } from 'bun:test'
import { formatCrossSessionMessage } from './crossSessionMessages'

test('formatCrossSessionMessage wraps and escapes cross-session content', () => {
  expect(formatCrossSessionMessage('uds:/tmp/a&b.sock', 'Check <parser> & UI')).toBe(
    '<cross-session-message from="uds:/tmp/a&amp;b.sock">\nCheck &lt;parser&gt; &amp; UI\n</cross-session-message>',
  )
})
