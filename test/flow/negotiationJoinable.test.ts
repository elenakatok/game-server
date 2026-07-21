import { describe, it, expect } from 'vitest'
import { negotiationIsJoinable } from '../../src/flow/negotiationJoinable'

const ctx = { gameInstanceId: 'i', participantCount: 3 }

describe('negotiationIsJoinable (spec §3.1 — group not yet negotiating)', () => {
  it('joinable ONLY while freshly matched', () => {
    expect(negotiationIsJoinable({ status: 'matched' }, ctx)).toBe(true)
  })
  it('closed once negotiating or beyond', () => {
    for (const status of ['negotiating', 'reporting', 'deadlocked', 'completed']) {
      expect(negotiationIsJoinable({ status }, ctx)).toBe(false)
    }
  })
  it('closed on a missing/garbage status', () => {
    expect(negotiationIsJoinable({}, ctx)).toBe(false)
    expect(negotiationIsJoinable({ status: 'whatever' }, ctx)).toBe(false)
  })
  it('ignores participant count — no size cap (§3.2)', () => {
    expect(negotiationIsJoinable({ status: 'matched' }, { gameInstanceId: 'i', participantCount: 999 })).toBe(true)
  })
})
