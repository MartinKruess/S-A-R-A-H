import { z } from 'zod';

export const ROUTER_PROPOSAL_PREFIX = 'SARAH_PROPOSAL_V1 ';
export const MAX_ROUTER_PROPOSAL_LENGTH = 4_096;

const evidenceSchema = z.string().trim().min(1).max(500);

const actionProposalSchema = z.object({
  kind: z.literal('action'),
  action: z.string().trim().min(1).max(64),
  param: z.string().trim().max(300),
  evidence: evidenceSchema,
}).strict();

const answerProposalSchema = z.object({
  kind: z.literal('answer'),
  evidence: evidenceSchema,
}).strict();

const handoffProposalSchema = z.object({
  kind: z.literal('handoff'),
  specialist: z.enum(['coding', 'research', 'vision']),
  evidence: evidenceSchema,
}).strict();

const planIntentSchema = z.discriminatedUnion('kind', [
  actionProposalSchema,
  answerProposalSchema,
  handoffProposalSchema,
]);

const boundedMultiIntentProposalSchema = z.object({
  intents: z.array(planIntentSchema).min(2).max(3),
}).strict();

const singleSpecialistHandoffProposalSchema = z.object({
  intents: z.tuple([
    z.object({
      kind: z.literal('handoff'),
      specialist: z.enum(['coding', 'research']),
      evidence: evidenceSchema,
    }).strict(),
  ]),
}).strict();

export const routerPlanProposalSchema = z.union([
  singleSpecialistHandoffProposalSchema,
  boundedMultiIntentProposalSchema,
]);

export type RouterPlanProposal = z.infer<typeof routerPlanProposalSchema>;
export type RouterIntentProposal = RouterPlanProposal['intents'][number];

export type RouterProposalParseFailure =
  | 'unrecognized'
  | 'oversized'
  | 'invalid_json'
  | 'invalid_schema';

export type RouterProposalParseResult =
  | { readonly ok: true; readonly proposal: RouterPlanProposal }
  | { readonly ok: false; readonly reason: RouterProposalParseFailure };

/**
 * @param output - Vollständige, nicht vertrauenswürdige Router-Ausgabe.
 *
 * - Akzeptiert ausschließlich das verankerte V1-Präfix mit strengem JSON.
 * - Akzeptiert einen einzelnen Coding-/Research-Handoff oder zwei bis drei Intents.
 * - Begrenzt Ausgabegröße, Intent-Anzahl und erlaubte Felder.
 * - Führt keine Aktionen oder Handoffs aus.
 *
 * @returns Validierter Proposal oder ein strukturierter Ablehnungsgrund.
 *
 * @category Validation
 */
export function parseRouterPlanProposal(output: string): RouterProposalParseResult {
  if (output.length > MAX_ROUTER_PROPOSAL_LENGTH) {
    return { ok: false, reason: 'oversized' };
  }

  const normalizedOutput = output.normalize('NFC').trim();
  if (!normalizedOutput.startsWith(ROUTER_PROPOSAL_PREFIX)) {
    return { ok: false, reason: 'unrecognized' };
  }

  const payload = normalizedOutput.slice(ROUTER_PROPOSAL_PREFIX.length);
  let parsedJson: object;
  try {
    parsedJson = JSON.parse(payload) as object;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const parsedProposal = routerPlanProposalSchema.safeParse(parsedJson);
  if (!parsedProposal.success) {
    return { ok: false, reason: 'invalid_schema' };
  }

  return { ok: true, proposal: parsedProposal.data };
}
