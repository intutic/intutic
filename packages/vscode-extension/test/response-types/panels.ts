/** The panels' item types (`src/webview.ts`), against the routes they render. */
import type { IncidentListResponse, SopListResponse, WasmRuleListResponse } from '@intutic/shared-types'
import type { IncidentList, SopList, WasmRuleItem } from '../../src/webview'
import { conforms } from './conforms'

// Active SOPs: GET /api/v1/sops
conforms<SopList>()<SopListResponse>()
// Governance incidents: GET /api/v1/incidents
conforms<IncidentList>()<IncidentListResponse>()
// WASM rule bundles: GET /api/v1/wasm-rules
conforms<WasmRuleItem[]>()<WasmRuleListResponse>()
