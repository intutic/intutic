/**
 * Responses of the org-level SOP routes (`routes/orgSops.ts`):
 * `/api/v1/workspace/org-sops`.
 *
 * @module
 */
import { z } from 'zod'
import { IsoTimestamp } from './common.js'

/** An org-level SOP, as `sopService.ts` `createOrgSop` and `listOrgSops` return it. */
export const OrgSopResponse = z.object({
  orgSopId: z.string(),
  orgId: z.string(),
  title: z.string(),
  markdownContent: z.string(),
  riskTier: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  isActive: z.boolean(),
  /** Evaluations the SOP ran in shadow mode. */
  shadowEvaluations: z.number().int(),
  /** Of those, the ones it would have blocked. */
  shadowWouldBlock: z.number().int(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
})
export type OrgSopResponse = z.infer<typeof OrgSopResponse>

/** `GET /api/v1/workspace/org-sops`: the org's active SOPs, newest first. */
export const OrgSopListResponse = z.object({ data: z.array(OrgSopResponse) })
export type OrgSopListResponse = z.infer<typeof OrgSopListResponse>
