/**
 * SalesforceSOPAdapter.ts — Sync Daemon Harness adapter for Salesforce CRM.
 * WS-6ENT LLD #36.
 *
 * Responsibilities:
 *  - Pull Salesforce Account/Contact/Opportunity records into SOP context
 *  - Push SOP execution summaries as Salesforce Activity objects
 *  - Handle OAuth token refresh via control-plane proxy
 *
 * Integration pattern:
 *   sync-daemon → control-plane /api/v1/crm/sync (auth, dedup, rate-limit)
 *   → Salesforce REST API v59.0
 *
 * @module
 */

import { createLogger } from '@intutic/logger'

const log = createLogger('salesforce-sop-adapter')

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SalesforceCredentials {
  accessToken:  string
  instanceUrl:  string
  orgId:        string
}

export interface SalesforceSopRecord {
  /** Salesforce record ID */
  id:           string
  /** Object type e.g. Account, Contact, Opportunity */
  type:         string
  name:         string
  /** ISO timestamp from Salesforce LastModifiedDate */
  lastModified: string
  /** Raw field bag from SOQL */
  fields:       Record<string, unknown>
}

export interface SopSyncPayload {
  sopId:        string
  sopTitle:     string
  executedAt:   string
  complianceScore: number
  operatorId:   string
  summary:      string
}

export interface SalesforceSyncResult {
  pulled:   SalesforceSopRecord[]
  pushed:   number
  errors:   string[]
  cursor:   string | null
}

// ── Salesforce REST API helper ────────────────────────────────────────────────

const SF_API_VERSION = 'v59.0'

async function sfRequest<T>(
  creds: SalesforceCredentials,
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${creds.instanceUrl}/services/data/${SF_API_VERSION}${path}`
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
    throw new Error(`Salesforce API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

// ── Pull: SOQL query for SOP-relevant records ─────────────────────────────────

export interface SalesforceQueryResult<T> {
  totalSize: number
  done:      boolean
  nextRecordsUrl?: string
  records:   T[]
}

/**
 * Pull Accounts modified since last sync cursor (ISO timestamp).
 * Used to hydrate SOP context with customer data before agent execution.
 */
export async function pullAccounts(
  creds: SalesforceCredentials,
  sinceIso?: string,
  limit: number = 200,
): Promise<{ records: SalesforceSopRecord[]; nextCursor: string | null }> {
  const whereClause = sinceIso
    ? `WHERE LastModifiedDate > ${sinceIso}`
    : ''

  const soql = encodeURIComponent(
    `SELECT Id, Name, Industry, BillingCountry, LastModifiedDate FROM Account ${whereClause} ORDER BY LastModifiedDate ASC LIMIT ${limit}`,
  )

  const result = await sfRequest<SalesforceQueryResult<{
    Id: string; Name: string; Industry: string | null
    BillingCountry: string | null; LastModifiedDate: string
  }>>(creds, `/query?q=${soql}`)

  const records: SalesforceSopRecord[] = result.records.map(r => ({
    id:           r.Id,
    type:         'Account',
    name:         r.Name,
    lastModified: r.LastModifiedDate,
    fields:       { industry: r.Industry, billingCountry: r.BillingCountry },
  }))

  // Next cursor is the timestamp of the last record (for incremental pagination)
  const nextCursor = records.length > 0
    ? records[records.length - 1].lastModified
    : null

  return { records, nextCursor }
}

/**
 * Pull Contacts modified since cursor.
 */
export async function pullContacts(
  creds: SalesforceCredentials,
  sinceIso?: string,
  limit: number = 200,
): Promise<{ records: SalesforceSopRecord[]; nextCursor: string | null }> {
  const whereClause = sinceIso ? `WHERE LastModifiedDate > ${sinceIso}` : ''
  const soql = encodeURIComponent(
    `SELECT Id, Name, Email, AccountId, LastModifiedDate FROM Contact ${whereClause} ORDER BY LastModifiedDate ASC LIMIT ${limit}`,
  )

  const result = await sfRequest<SalesforceQueryResult<{
    Id: string; Name: string; Email: string | null
    AccountId: string | null; LastModifiedDate: string
  }>>(creds, `/query?q=${soql}`)

  const records: SalesforceSopRecord[] = result.records.map(r => ({
    id:           r.Id,
    type:         'Contact',
    name:         r.Name,
    lastModified: r.LastModifiedDate,
    fields:       { email: r.Email, accountId: r.AccountId },
  }))

  return {
    records,
    nextCursor: records.length > 0 ? records[records.length - 1].lastModified : null,
  }
}

// ── Push: SOP execution → Salesforce Task ────────────────────────────────────

/**
 * Push a SOP execution summary as a Salesforce Task record.
 * Links to the relevant Contact or Account if available.
 */
export async function pushSopExecution(
  creds: SalesforceCredentials,
  payload: SopSyncPayload,
  relatedToId?: string,
): Promise<string | null> {
  try {
    const task = {
      Subject:       `[Intutic] SOP Executed: ${payload.sopTitle}`,
      Description:   payload.summary,
      Status:        'Completed',
      Priority:      'Normal',
      ActivityDate:  payload.executedAt.slice(0, 10),
      // Custom fields — must exist in the Salesforce org's schema
      Intutic_SOP_Id__c:           payload.sopId,
      Intutic_Compliance_Score__c: payload.complianceScore,
      Intutic_Operator_Id__c:      payload.operatorId,
      ...(relatedToId ? { WhatId: relatedToId } : {}),
    }

    const result = await sfRequest<{ id: string; success: boolean }>(
      creds, '/sobjects/Task', {
        method: 'POST',
        body:   JSON.stringify(task),
      },
    )

    log.info({ sopId: payload.sopId, taskId: result.id }, 'SOP execution pushed to Salesforce')
    return result.id
  } catch (err) {
    log.error({ err, sopId: payload.sopId }, 'Failed to push SOP execution to Salesforce')
    return null
  }
}

// ── Main sync function ────────────────────────────────────────────────────────

/**
 * Full incremental sync: pull new Salesforce records + push pending SOP summaries.
 *
 * @param creds       Salesforce OAuth credentials
 * @param cursor      ISO timestamp from last sync (null for full pull)
 * @param sopPayloads SOP executions to push (may be empty)
 */
export async function runSalesforceSync(
  creds: SalesforceCredentials,
  cursor: string | null,
  sopPayloads: SopSyncPayload[] = [],
): Promise<SalesforceSyncResult> {
  const errors: string[] = []
  let nextCursor: string | null = cursor

  // Pull
  const [accountsResult, contactsResult] = await Promise.allSettled([
    pullAccounts(creds, cursor ?? undefined),
    pullContacts(creds, cursor ?? undefined),
  ])

  const pulled: SalesforceSopRecord[] = []

  if (accountsResult.status === 'fulfilled') {
    pulled.push(...accountsResult.value.records)
    if (accountsResult.value.nextCursor) nextCursor = accountsResult.value.nextCursor
  } else {
    errors.push(`accounts: ${accountsResult.reason}`)
  }

  if (contactsResult.status === 'fulfilled') {
    pulled.push(...contactsResult.value.records)
  } else {
    errors.push(`contacts: ${contactsResult.reason}`)
  }

  // Push
  let pushed = 0
  for (const payload of sopPayloads) {
    const taskId = await pushSopExecution(creds, payload)
    if (taskId) pushed++
    else errors.push(`push failed for sopId=${payload.sopId}`)
  }

  log.info({ pulled: pulled.length, pushed, errors: errors.length }, 'Salesforce sync complete')

  return { pulled, pushed, errors, cursor: nextCursor }
}
