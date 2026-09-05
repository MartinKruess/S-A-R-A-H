import { z } from 'zod';
export const CodexLoginInputSchema = z.object({ acknowledgementVersion: z.literal('2026-09-05.codex-managed-chatgpt.v1') }).strict();
export const CodexConnectionStateSchema = z.object({
  state: z.enum(['not_connected','waiting','connected','unavailable']),
  message: z.string().max(500),
  verificationUrl: z.literal('https://auth.openai.com/codex/device').optional(),
  userCode: z.string().max(64).optional(),
}).strict();
export type CodexConnectionState = z.infer<typeof CodexConnectionStateSchema>;
export type CodexLoginInput = z.infer<typeof CodexLoginInputSchema>;
