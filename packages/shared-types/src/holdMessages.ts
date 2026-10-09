/**
 * What a held tool call tells the agent and the person reading its transcript.
 *
 * The harness hook gates and the MCP governance proxy both hold calls through
 * the same decisions API, so they print the same sentence. It has to be true
 * for whoever reads it:
 *
 * - Approving takes a reviewer role (`DECISION_REVIEWER_ROLES` in the control
 *   plane: OWNER, ADMIN, EM). The developer whose agent was held usually
 *   cannot approve it, so the message names who can.
 * - An approval lets the identical retry through only while the workspace's
 *   review-hold bypass (`reviewHoldBypassEnabled`) is on, which it is not by
 *   default. Otherwise the approval is recorded and the retry is held again.
 *   A gate cannot tell which, so the message states the condition.
 *
 * The text carries no quote, dollar sign or backtick, so the hook gates can
 * embed it in generated shell inside single quotes. `{holdId}` stands for the
 * hold id wherever it appears.
 */
export const HOLD_APPROVAL_HINT_TEMPLATE =
  'An Owner, Admin or EM can approve it with: intutic decision approve {holdId} ' +
  '(or reject it: intutic decision reject {holdId}). Retrying this exact call passes ' +
  'after approval only if the workspace has turned on the review-hold bypass; ' +
  'otherwise it is held again.'

/** The placeholder {@link HOLD_APPROVAL_HINT_TEMPLATE} uses for the hold id. */
export const HOLD_ID_PLACEHOLDER = '{holdId}'

/** {@link HOLD_APPROVAL_HINT_TEMPLATE} for one hold. */
export function holdApprovalHint(holdId: string): string {
  return HOLD_APPROVAL_HINT_TEMPLATE.split(HOLD_ID_PLACEHOLDER).join(holdId)
}
