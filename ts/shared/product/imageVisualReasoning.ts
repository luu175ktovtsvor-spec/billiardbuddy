import { z } from 'zod/v4'

const boundedText = z.string().min(1).max(500)
const dataUrlSchema = z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).max(12 * 1024 * 1024)
const referenceSchema = z.object({
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  role: z.enum(['subject', 'product', 'character', 'style', 'composition', 'environment', 'brand', 'logo', 'qrcode']),
  influence_strength: z.enum(['low', 'medium', 'high']), preservation: z.enum(['may_change', 'prefer_preserve', 'must_preserve', 'exact']),
  priority: z.number().int().min(0).max(1_000), data_url: dataUrlSchema,
}).strict()
const confidenceSchema = z.enum(['high', 'medium', 'low'])
const understandingOutputSchema = z.object({
  confidence: confidenceSchema, visible_facts: z.array(boundedText).max(30), preservation_risks: z.array(boundedText).max(20),
  composition_suggestions: z.array(boundedText).max(20), missing_information: z.array(boundedText).max(20),
}).strict()
const assessmentOutputSchema = z.object({
  confidence: confidenceSchema, observations: z.array(boundedText).max(20), risks: z.array(boundedText).max(20),
  repair_actions: z.array(z.object({ kind: z.enum(['keep', 'derive', 'inpaint', 'regenerate', 'canvas']), rationale: boundedText }).strict()).max(5),
}).strict()

/** Shared Gateway contract; raw provider prompts and responses never cross it. */
export const imageVisualReasoningRequestSchema = z.discriminatedUnion('application_role', [
  z.object({ schema_version: z.literal(1), application_role: z.literal('image_understanding'), idempotency_key: z.string().min(16).max(160), input: z.object({ user_request: z.string().min(1).max(8_000), confirmed_facts: z.array(boundedText).max(40), must_preserve: z.array(boundedText).max(40), references: z.array(referenceSchema).min(1).max(8) }).strict() }).strict(),
  z.object({ schema_version: z.literal(1), application_role: z.literal('image_visual_assessment'), idempotency_key: z.string().min(16).max(160), input: z.object({ user_request: z.string().min(1).max(8_000), confirmed_facts: z.array(boundedText).max(40), must_preserve: z.array(boundedText).max(40), candidate: z.object({ content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), data_url: dataUrlSchema }).strict() }).strict() }).strict(),
])

export const imageVisualReasoningResponseSchema = z.discriminatedUnion('application_role', [
  z.object({ schema_version: z.literal(1), application_role: z.literal('image_understanding'), provider: z.literal('qwen'), model_id: z.literal('qwen3-vl-flash'), provider_request_id: z.string().min(1).max(256).optional(), usage: z.object({ input_bytes: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(), output: understandingOutputSchema }).strict(),
  z.object({ schema_version: z.literal(1), application_role: z.literal('image_visual_assessment'), provider: z.literal('qwen'), model_id: z.literal('qwen3-vl-flash'), provider_request_id: z.string().min(1).max(256).optional(), usage: z.object({ input_bytes: z.number().int().nonnegative(), input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(), output: assessmentOutputSchema }).strict(),
])

export type ImageVisualReasoningRequest = z.input<typeof imageVisualReasoningRequestSchema>
export type ImageVisualReasoningResponse = z.infer<typeof imageVisualReasoningResponseSchema>
