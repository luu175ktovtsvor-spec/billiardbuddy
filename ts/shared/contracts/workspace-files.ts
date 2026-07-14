import { z } from 'zod'

const workspaceSheetSchema = z.object({
  name: z.string(),
  rows: z.array(z.array(z.string())),
})

const workspaceDocumentBlockSchema = z.object({
  id: z.string(),
  kind: z.enum(['paragraph', 'slide_text']),
  text: z.string(),
  meta: z.record(z.string(), z.unknown()).optional(),
})

export const workspaceSpreadsheetPreviewSchema = z.object({
  kind: z.literal('spreadsheet'),
  path: z.string(),
  name: z.string(),
  sheet_names: z.array(z.string()),
  sheets: z.array(workspaceSheetSchema),
  truncated: z.boolean(),
})

export const workspaceDocumentPreviewSchema = z.object({
  kind: z.literal('document'),
  path: z.string(),
  name: z.string(),
  document_kind: z.enum(['docx', 'pptx']),
  blocks: z.array(workspaceDocumentBlockSchema),
  truncated: z.boolean(),
})

export const workspaceFilePreviewSchema = z.discriminatedUnion('kind', [
  workspaceSpreadsheetPreviewSchema,
  workspaceDocumentPreviewSchema,
])

export type WorkspaceFilePreview = z.infer<typeof workspaceFilePreviewSchema>
