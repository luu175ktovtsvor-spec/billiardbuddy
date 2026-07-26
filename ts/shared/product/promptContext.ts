export type ProductPromptContext = {
  workspace: string
  date: string
  projectInstructions?: string | null
  hookInstructions?: string | null
  projectMemory?: string | null
  sessionSummary?: string | null
}
