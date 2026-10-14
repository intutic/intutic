/** SDK response types of the org-level SOP routes, against their schemas. */
import type { OrgSopListResponse, OrgSopResponse } from '@intutic/shared-types'
import type { OrgSop } from '../../src/types'
import { conforms, type Rows } from './conforms'

// createOrgSop: POST /api/v1/workspace/org-sops
conforms<OrgSop>()<OrgSopResponse>()
// listOrgSops: GET /api/v1/workspace/org-sops, unwrapped from `data`
conforms<OrgSop>()<Rows<OrgSopListResponse, 'data'>>()
