import { expect, test } from 'bun:test'
import { appendCitationMarkdown, normalizeUrlCitations } from './citations'

test('citations keep safe HTTP sources, deduplicate URLs and escape labels', () => {
  const citations = normalizeUrlCitations([
    { type: 'url_citation', url: 'https://example.com/a', title: 'A [guide]' },
    { type: 'url_citation', url: 'https://example.com/a', title: 'duplicate' },
    { type: 'url_citation', url: 'file:///tmp/secret', title: 'local' },
    { type: 'url_citation', url: 'javascript:alert(1)', title: 'script' },
    { type: 'other', url: 'https://example.com/ignored' },
  ])
  expect(citations).toEqual([{ url: 'https://example.com/a', title: 'A [guide]' }])
  expect(appendCitationMarkdown('正文', citations)).toBe(
    '正文\n\n参考来源\n\n1. [A \\[guide\\]](<https://example.com/a>)',
  )
})
