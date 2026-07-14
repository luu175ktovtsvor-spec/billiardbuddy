import { describe, expect, test } from 'bun:test'
import { workspaceFilePreviewSchema } from './workspace-files'

describe('workspace file preview contract', () => {
  test('accepts structured spreadsheet and document previews', () => {
    expect(workspaceFilePreviewSchema.parse({
      kind: 'spreadsheet',
      path: '/workspace/report.csv',
      name: 'report.csv',
      sheet_names: ['Sheet1'],
      sheets: [{ name: 'Sheet1', rows: [['name', 'value'], ['revenue', '1200']] }],
      truncated: false,
    }).kind).toBe('spreadsheet')

    expect(workspaceFilePreviewSchema.parse({
      kind: 'document',
      path: '/workspace/brief.docx',
      name: 'brief.docx',
      document_kind: 'docx',
      blocks: [{ id: 'b0', kind: 'paragraph', text: 'Weekly summary' }],
      truncated: false,
    }).kind).toBe('document')
  })

  test('rejects malformed and pre-contract responses', () => {
    expect(workspaceFilePreviewSchema.safeParse({ kind: 'spreadsheet', sheets: 'invalid' }).success).toBe(false)
    expect(workspaceFilePreviewSchema.safeParse({
      name: 'legacy.xlsx',
      sheet_names: ['Sheet1'],
      sheets: [{ name: 'Sheet1', rows: [] }],
      truncated: false,
    }).success).toBe(false)
  })
})
