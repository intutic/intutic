/** SDK response types of the gateway, workspace-settings and provider-credential routes, against their schemas. */
import type {
  GatewayConfigResponse,
  GatewayListResponse,
  GatewayRegisterResponse,
  GatewayResolutionResponse,
  GatewayRotateResponse,
  GatewayStatusResponse,
  ProviderCredentialListResponse,
  ProviderCredentialStatusResponse,
  ProviderModelListResponse,
  WorkspaceGatewayResponse,
  WorkspaceSettingsResponse,
  WorkspaceSettingsUpdateResponse,
} from '@intutic/shared-types'
import type {
  Gateway,
  GatewayConfigResult,
  GatewayRegisterResult,
  GatewayResolution,
  GatewayRotateResult,
  GatewayStatus,
  ProviderCredentialStatus,
  ProviderModelList,
  WorkspaceSettings,
  WorkspaceSettingsUpdateResult,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

// registerGateway: POST /api/v1/gateways
conforms<GatewayRegisterResult>()<GatewayRegisterResponse>()
// listGateways: GET /api/v1/gateways, unwrapped from `data`
conforms<Gateway>()<Rows<GatewayListResponse, 'data'>>()
// getGatewayStatus: GET /api/v1/gateways/:id/status
conforms<GatewayStatus>()<GatewayStatusResponse>()
// rotateGatewayToken: POST /api/v1/gateways/:id/rotate
conforms<GatewayRotateResult>()<GatewayRotateResponse>()
// getGatewayConfig: GET /api/v1/gateways/:id/config; setGatewayConfig: PATCH /api/v1/gateways/:id/config
conforms<GatewayConfigResult>()<GatewayConfigResponse>()
// assignWorkspaceGateway: PATCH /api/v1/workspace/gateway
conforms<{ gatewayId: string | null }>()<WorkspaceGatewayResponse>()
// resolveGateway: GET /api/v1/workspace/gateway-resolution
conforms<GatewayResolution>()<GatewayResolutionResponse>()
// getWorkspaceSettings: GET /api/v1/workspace/settings
conforms<WorkspaceSettings>()<WorkspaceSettingsResponse>()
// updateWorkspaceSettings: PUT /api/v1/workspace/settings
conforms<WorkspaceSettingsUpdateResult>()<WorkspaceSettingsUpdateResponse>()
// listProviderCredentials: GET /api/v1/workspace/provider-credentials, unwrapped from `data`
conforms<ProviderCredentialStatus>()<Rows<ProviderCredentialListResponse, 'data'>>()
// setProviderCredential: PUT /api/v1/workspace/provider-credentials/:provider
conforms<ProviderCredentialStatus>()<ProviderCredentialStatusResponse>()
// listProviderModels: GET /api/v1/workspace/provider-credentials/:provider/models
conforms<ProviderModelList>()<ProviderModelListResponse>()
