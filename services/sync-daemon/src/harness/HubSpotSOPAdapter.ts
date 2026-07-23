/**
 * HubSpotSOPAdapter.ts — Sync Daemon Harness adapter for HubSpot CRM.
 * WS-6ENT LLD #36.
 *
 * Responsibilities:
 *  - Pull HubSpot Contacts and Companies since last sync cursor
 *  - Push SOP execution summaries as HubSpot Engagements (notes)
 *  - Handle OAuth refresh token flow via control-plane proxy
 *
 * HubSpot API v3 is used throughout.
 * Rate limit: 100 requests / 10 seconds (handled by caller throttle).
 *
 * @module
 */

import { createLogger } from '@intutic/logger'

const log = createLogger('hubspot-sop-adapter')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HubSpotCredentials {
  accessToken: string
  portalId:    string
}

export interface HubSpotRecord {
  id:           string
  type:         'contact' | 'company' | 'deal'
  properties:   Record<string, string | null>
  updatedAt:    string
}

export interface HubSpotSyncResult {
  pulled:   HubSpotRecord[]
  pushed:   number
  errors:   string[]
  cursor:   string | null
}

// ── HubSpot REST helper ───────────────────────────────────────────────────────

const HS_API_BASE = 'https://api.hubapi.com'

async function hsRequest<T>(
  creds: HubSpotCredentials,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${HS_API_BASE}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`HubSpot API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── Pull: Contacts ────────────────────────────────────────────────────────────

interface HsListResponse<T> {
  results: T[]
  paging?: { next?: { after: string } }
}

interface HsContact {
  id: string
  properties: {
    firstname?: string | null
    lastname?:  string | null
    email?:     string | null
    hs_lastmodifieddate?: string | null
  }
  updatedAt: string
}

/**
 * Pull HubSpot contacts updated after `sinceIso`.
 * Uses the CRM search API for filtered incremental pull.
 */
export async function pullContacts(
  creds: HubSpotCredentials,
  sinceIso?: string,
  limit: number = 100,
): Promise<{ records: HubSpotRecord[]; nextCursor: string | null }> {
  const body = {
    properties: ['firstname', 'lastname', 'email', 'hs_lastmodifieddate'],
    limit,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    ...(sinceIso ? {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator:     'GT',
          value:        new Date(sinceIso).getTime().toString(),
        }],
      }],
    } : {}),
  }

  const result = await hsRequest<HsListResponse<HsContact>>(
    creds,
    '/crm/v3/objects/contacts/search',
    { method: 'POST', body: JSON.stringify(body) },
  )

  const records: HubSpotRecord[] = result.results.map(r => ({
    id:         r.id,
    type:       'contact',
    properties: {
      firstname: r.properties.firstname ?? null,
      lastname:  r.properties.lastname  ?? null,
      email:     r.properties.email     ?? null,
    },
    updatedAt:  r.updatedAt,
  }))

  const nextCursor = result.paging?.next?.after ?? null
  return { records, nextCursor }
}

// ── Pull: Companies ───────────────────────────────────────────────────────────

interface HsCompany {
  id: string
  properties: {
    name?: string | null
    domain?: string | null
    industry?: string | null
    hs_lastmodifieddate?: string | null
  }
  updatedAt: string
}

/**
 * Pull HubSpot companies updated after `sinceIso`.
 */
export async function pullCompanies(
  creds: HubSpotCredentials,
  sinceIso?: string,
  limit: number = 100,
): Promise<{ records: HubSpotRecord[]; nextCursor: string | null }> {
  const body = {
    properties: ['name', 'domain', 'industry', 'hs_lastmodifieddate'],
    limit,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    ...(sinceIso ? {
      filterGroups: [{
        filters: [{
          propertyName: 'hs_lastmodifieddate',
          operator:     'GT',
          value:        new Date(sinceIso).getTime().toString(),
        }],
      }],
    } : {}),
  }

  const result = await hsRequest<HsListResponse<HsCompany>>(
    creds,
    '/crm/v3/objects/companies/search',
    { method: 'POST', body: JSON.stringify(body) },
  )

  const records: HubSpotRecord[] = result.results.map(r => ({
    id:         r.id,
    type:       'company',
    properties: {
      name:     r.properties.name     ?? null,
      domain:   r.properties.domain   ?? null,
      industry: r.properties.industry ?? null,
    },
    updatedAt:  r.updatedAt,
  }))

  return { records, nextCursor: result.paging?.next?.after ?? null }
}

// ── Push: SOP execution → HubSpot Note ───────────────────────────────────────

export interface SopSyncPayload {
  sopId:           string
  sopTitle:        string
  executedAt:      string
  complianceScore: number
  operatorId:      string
  summary:         string
}

/**
 * Push a SOP execution summary as a HubSpot Engagement (note).
 * Optionally associate with a contact or company record.
 */
export async function pushSopExecution(
  creds: HubSpotCredentials,
  payload: SopSyncPayload,
  associatedObjectId?: string,
  associatedObjectType: 'contact' | 'company' = 'contact',
): Promise<string | null> {
  try {
    const noteBody = {
      properties: {
        hs_note_body: [
          `**[Intutic] SOP Executed: ${payload.sopTitle}**`,
          `SOP ID: ${payload.sopId}`,
          `Compliance Score: ${payload.complianceScore.toFixed(2)}%`,
          `Operator: ${payload.operatorId}`,
          `Executed At: ${payload.executedAt}`,
          '',
          payload.summary,
        ].join('\n'),
        hs_timestamp: new Date(payload.executedAt).getTime().toString(),
      },
    }

    const note = await hsRequest<{ id: string }>(
      creds,
      '/crm/v3/objects/notes',
      { method: 'POST', body: JSON.stringify(noteBody) },
    )

    // Associate note with contact / company if provided
    if (associatedObjectId) {
      const associationType = associatedObjectType === 'contact' ? 202 : 214
      await hsRequest(
        creds,
        `/crm/v3/objects/notes/${note.id}/associations/${associatedObjectType}s/${associatedObjectId}/${associationType}`,
        { method: 'PUT' },
      ).catch(err => log.warn({ err }, 'Failed to associate note'))
    }

    log.info({ sopId: payload.sopId, noteId: note.id }, 'SOP execution pushed to HubSpot')
    return note.id
  } catch (err) {
    log.error({ err, sopId: payload.sopId }, 'Failed to push SOP execution to HubSpot')
    return null
  }
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Full incremental sync: pull contacts + companies, push SOP summaries.
 */
export async function runHubSpotSync(
  creds: HubSpotCredentials,
  cursor: string | null,
  sopPayloads: SopSyncPayload[] = [],
): Promise<HubSpotSyncResult> {
  const errors: string[] = []
  let nextCursor: string | null = cursor

  const [contactsResult, companiesResult] = await Promise.allSettled([
    pullContacts(creds, cursor ?? undefined),
    pullCompanies(creds, cursor ?? undefined),
  ])

  const pulled: HubSpotRecord[] = []

  if (contactsResult.status === 'fulfilled') {
    pulled.push(...contactsResult.value.records)
    if (contactsResult.value.nextCursor) nextCursor = contactsResult.value.nextCursor
  } else {
    errors.push(`contacts: ${contactsResult.reason}`)
  }

  if (companiesResult.status === 'fulfilled') {
    pulled.push(...companiesResult.value.records)
  } else {
    errors.push(`companies: ${companiesResult.reason}`)
  }

  let pushed = 0
  for (const payload of sopPayloads) {
    const noteId = await pushSopExecution(creds, payload)
    if (noteId) pushed++
    else errors.push(`push failed for sopId=${payload.sopId}`)
  }

  log.info({ pulled: pulled.length, pushed, errors: errors.length }, 'HubSpot sync complete')

  return { pulled, pushed, errors, cursor: nextCursor }
}
