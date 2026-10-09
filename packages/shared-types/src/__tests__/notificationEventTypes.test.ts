/**
 * NOTIFICATION_EVENT_TYPES is what the API validates a rule's event type
 * against; the Terraform provider checks plans against its own copy.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, expectTypeOf } from 'vitest'
import { NOTIFICATION_EVENT_TYPES, type NotificationEventType } from '../notifications.js'

const TERRAFORM_COPY = fileURLToPath(
  new URL('../../../terraform-provider-intutic/internal/provider/notification_event_types.json', import.meta.url),
)

describe('NOTIFICATION_EVENT_TYPES', () => {
  it('is the NotificationEventType union, each type once', () => {
    expectTypeOf<(typeof NOTIFICATION_EVENT_TYPES)[number]>().toEqualTypeOf<NotificationEventType>()
    expect(new Set(NOTIFICATION_EVENT_TYPES).size).toBe(NOTIFICATION_EVENT_TYPES.length)
    for (const type of NOTIFICATION_EVENT_TYPES) expect(type).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
  })

  it('matches the Terraform provider\'s copy', () => {
    const copy = JSON.parse(readFileSync(TERRAFORM_COPY, 'utf8')) as { eventTypes: string[] }
    // On a mismatch, write `{ "eventTypes": NOTIFICATION_EVENT_TYPES }` to the file, two-space indented.
    expect(copy.eventTypes).toEqual([...NOTIFICATION_EVENT_TYPES])
  })
})
