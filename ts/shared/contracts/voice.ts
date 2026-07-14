import { z } from 'zod'

export const voiceTranscriptionResponseSchema = z.object({
  text: z.string().min(1).max(20_000),
})

export const voiceTranscriptionSegmentSchema = z.object({
  id: z.number().int().nonnegative(),
  start: z.number().nonnegative(),
  end: z.number().positive(),
  text: z.string().min(1).max(20_000),
}).refine(segment => segment.end > segment.start, { message: 'segment end must be after start' })

export const voiceVerboseTranscriptionResponseSchema = z.object({
  text: z.string().min(1).max(1_000_000),
  language: z.string().min(2).max(16),
  duration: z.number().nonnegative(),
  segments: z.array(voiceTranscriptionSegmentSchema).max(100_000),
})

export const voiceRemoteTranscriptionResponseSchema = z.union([
  voiceVerboseTranscriptionResponseSchema,
  voiceTranscriptionResponseSchema,
])

export const voiceErrorResponseSchema = z.object({
  detail: z.string().min(1).max(2_000),
})

export type VoiceTranscriptionResponse = z.infer<typeof voiceTranscriptionResponseSchema>
export type VoiceVerboseTranscriptionResponse = z.infer<typeof voiceVerboseTranscriptionResponseSchema>
