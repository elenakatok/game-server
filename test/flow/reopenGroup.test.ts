import { describe, it, expect, vi } from 'vitest'

// firebase-admin/firestore is not available in the pure unit env; stub FieldValue so the
// patch builder can be exercised without the admin SDK. The sentinels are opaque markers
// here — we assert their PRESENCE and the static field values, which is what callers rely on.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__serverTimestamp__',
    delete: () => '__delete__',
  },
}))

import { reopenGroupPatch } from '../../src/flow/reopenGroup'

describe('reopenGroupPatch', () => {
  it('re-opens to negotiating and clears the transient per-round working fields', () => {
    const patch = reopenGroupPatch()
    expect(patch.status).toBe('negotiating')
    expect(patch.lead_outcome).toBeNull()
    expect(patch.lead_reported_at).toBeNull()
    expect(patch.confirmations).toEqual({})
    expect(patch.reset_count).toBe(0)
  })

  it('re-stamps negotiation_started_at and drops the previous round lock via sentinels', () => {
    const patch = reopenGroupPatch()
    expect(patch.negotiation_started_at).toBe('__serverTimestamp__')
    expect(patch.completed_at).toBe('__delete__')
    expect(patch.instructor_override).toBe('__delete__')
  })

  it('NEVER touches stored round outcomes — no outcome / outcomes_by_round key in the patch', () => {
    const patch = reopenGroupPatch()
    expect('outcome' in patch).toBe(false)
    expect('outcomes_by_round' in patch).toBe(false)
    // Exactly the eight transient fields, nothing more.
    expect(Object.keys(patch).sort()).toEqual([
      'completed_at',
      'confirmations',
      'instructor_override',
      'lead_outcome',
      'lead_reported_at',
      'negotiation_started_at',
      'reset_count',
      'status',
    ])
  })
})
