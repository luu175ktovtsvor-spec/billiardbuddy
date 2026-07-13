import { z } from 'zod'

export const voiceTranscriptionResponseSchema = z.object({
  text: z.string().min(1).max(20_000),
})

export const voiceErrorResponseSchema = z.object({
  detail: z.string().min(1).max(2_000),
})

export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>
