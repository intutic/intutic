/** SDK response types of the identity routes (auth, domain verification, orgs, teams, signing keys, API keys), against their schemas. */
import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyResponse,
  AuthMeResponse,
  DomainVerificationResponse,
  DomainVerificationStartResponse,
  OrgCreateResponse,
  OrgGatewayResponse,
  OrgSignupTokensResponse,
  TeamCreateResponse,
  TeamListResponse,
  TeamWorkspaceCreateResponse,
  TeamWorkspaceListResponse,
  TraceSigningJwksResponse,
} from '@intutic/shared-types'
import type { ControlPlaneClient } from '../../src/control-plane'
import type {
  ApiKey,
  ApiKeyCreateResult,
  CheckDomainVerificationResult,
  CreateOrgResult,
  OrgSignupResult,
  SigningJwks,
  StartDomainVerificationResult,
  Team,
  WhoamiResult,
  Workspace,
} from '../../src/types'
import { conforms, type Rows } from './conforms'

type Resolved<M extends keyof ControlPlaneClient> = ControlPlaneClient[M] extends (...args: never[]) => Promise<infer R> ? R : never

// whoami: GET /api/v1/auth/me
conforms<WhoamiResult>()<AuthMeResponse>()
// signupOrg: POST /api/v1/auth/signup/org (the SDK reads tokens from the body, so it gets refreshToken)
conforms<OrgSignupResult>()<OrgSignupTokensResponse>()
// startDomainVerification: POST /api/v1/domain-verification/start
conforms<StartDomainVerificationResult>()<DomainVerificationStartResponse>()
// checkDomainVerification: GET /api/v1/domain-verification/:id
conforms<CheckDomainVerificationResult>()<DomainVerificationResponse>()
// createOrg: POST /api/v1/orgs
conforms<CreateOrgResult>()<OrgCreateResponse>()
// listTeams: GET /api/v1/orgs/:orgId/teams, unwrapped from `data`
conforms<Team>()<Rows<TeamListResponse, 'data'>>()
// createTeam: POST /api/v1/orgs/:orgId/teams
conforms<Resolved<'createTeam'>>()<TeamCreateResponse>()
// listTeamWorkspaces: GET /api/v1/teams/:teamId/workspaces, unwrapped from `data`
conforms<Workspace>()<Rows<TeamWorkspaceListResponse, 'data'>>()
// createWorkspace: POST /api/v1/teams/:teamId/workspaces
conforms<Resolved<'createWorkspace'>>()<TeamWorkspaceCreateResponse>()
// assignOrgGateway: PATCH /api/v1/orgs/:orgId/gateway
conforms<Resolved<'assignOrgGateway'>>()<OrgGatewayResponse>()
// getSigningKeys: GET /.well-known/intutic-trace-signing.json
conforms<SigningJwks>()<TraceSigningJwksResponse>()
// listApiKeys: GET /api/v1/keys, unwrapped from `data`
conforms<ApiKey>()<Rows<ApiKeyListResponse, 'data'>>()
// createApiKey: POST /api/v1/keys
conforms<ApiKeyCreateResult>()<ApiKeyCreateResponse>()
// updateApiKey: PATCH /api/v1/keys/:id
conforms<ApiKey>()<ApiKeyResponse>()
