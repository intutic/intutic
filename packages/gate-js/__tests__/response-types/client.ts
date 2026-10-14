/** The answers `src/client.ts` reads, against the routes that send them. */
import type { ApprovedBypassListResponse, HookGateResponse } from '@intutic/shared-types'
import type { ApprovedBypassesAnswer, HookGateAnswer } from '../../src/client.js'
import { conforms } from './conforms.js'

// hookGate: POST /api/v1/hook-gate
conforms<HookGateAnswer>()<HookGateResponse>()
// approvedBypasses: GET /api/v1/decisions/approved-bypasses
conforms<ApprovedBypassesAnswer>()<ApprovedBypassListResponse>()
