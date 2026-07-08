import { describe, it, expect } from 'vitest'
import {
  ATTENDANCE_BY_ROUND_FIELD,
  presenceAtSlot,
  setRoundPresence,
  getRoundPresence,
} from '../../src/join/roundPresence'

const rounds = ['1978', '1983', '1985']

// ── presenceAtSlot (Option-1 derive) ───────────────────────────────────────────

describe('presenceAtSlot', () => {
  it('flat slot reads the existing attendance_confirmed_at flag', () => {
    expect(presenceAtSlot({ attendance_confirmed_at: 123 }, { kind: 'flat' })).toBe(true)
    expect(presenceAtSlot({ attendance_confirmed_at: null }, { kind: 'flat' })).toBe(false)
    expect(presenceAtSlot({}, { kind: 'flat' })).toBe(false)
  })

  it('keyed slot reads its round from the map', () => {
    const p = {
      attendance_confirmed_at: 123, // round 1 present, untouched
      [ATTENDANCE_BY_ROUND_FIELD]: { '1983': 456 },
    }
    expect(presenceAtSlot(p, { kind: 'keyed', roundId: '1983' })).toBe(true)
    expect(presenceAtSlot(p, { kind: 'keyed', roundId: '1985' })).toBe(false)
  })

  it('keyed slot is absent when there is no map or no key', () => {
    expect(presenceAtSlot({}, { kind: 'keyed', roundId: '1983' })).toBe(false)
    expect(
      presenceAtSlot({ [ATTENDANCE_BY_ROUND_FIELD]: { '1985': 1 } }, { kind: 'keyed', roundId: '1983' }),
    ).toBe(false)
  })

  it('a round-1 flat flag does NOT satisfy a keyed round (the Slice 2.6 bug fix)', () => {
    // Student confirmed round 1 only; a round-2 slot must still read absent so verify
    // does not short-circuit their round-2 confirmation.
    const p = { attendance_confirmed_at: 123 }
    expect(presenceAtSlot(p, { kind: 'keyed', roundId: '1983' })).toBe(false)
  })
})

// ── setRoundPresence (patch builder) ────────────────────────────────────────────

describe('setRoundPresence', () => {
  it('flat slot writes the existing top-level field (byte-identical to before)', () => {
    expect(setRoundPresence({ kind: 'flat' }, 'TS')).toEqual({ attendance_confirmed_at: 'TS' })
  })

  it('keyed slot writes only the dotted round key — never the flat field', () => {
    const patch = setRoundPresence({ kind: 'keyed', roundId: '1983' }, 'TS')
    expect(patch).toEqual({ 'attendance_by_round.1983': 'TS' })
    expect(patch).not.toHaveProperty('attendance_confirmed_at')
  })

  it('a keyed write patch cannot clobber a sibling round or the flat flag', () => {
    // The dotted-path patch names only round 1983; applied over a doc holding round-1
    // flat + round 1985, both are untouched (Firestore semantics; asserted on shape).
    const patch = setRoundPresence({ kind: 'keyed', roundId: '1985' }, 'TS')
    expect(Object.keys(patch)).toEqual(['attendance_by_round.1985'])
  })
})

// ── getRoundPresence (public read helper) ───────────────────────────────────────

describe('getRoundPresence', () => {
  it('one-shot game (no rounds) always reads the flat flag', () => {
    expect(getRoundPresence({ attendance_confirmed_at: 1 }, undefined, 0)).toBe(true)
    expect(getRoundPresence({}, undefined, 0)).toBe(false)
    // A bad round index on a one-shot game still derives to flat.
    expect(getRoundPresence({ attendance_confirmed_at: 1 }, undefined, 7)).toBe(true)
  })

  it('round 1 (index 0) reads the flat flag', () => {
    expect(getRoundPresence({ attendance_confirmed_at: 1 }, rounds, 0)).toBe(true)
    expect(getRoundPresence({}, rounds, 0)).toBe(false)
  })

  it('rounds 2+ read the keyed slot', () => {
    const p = {
      attendance_confirmed_at: 1,
      [ATTENDANCE_BY_ROUND_FIELD]: { '1983': 2 },
    }
    expect(getRoundPresence(p, rounds, 1)).toBe(true)  // 1983 present
    expect(getRoundPresence(p, rounds, 2)).toBe(false) // 1985 absent
  })

  it('present day 1 but absent day 2 reads present@r1, absent@r2 (Slice-3 scorer case)', () => {
    const p = { attendance_confirmed_at: 1 } // only the flat round-1 flag ever set
    expect(getRoundPresence(p, rounds, 0)).toBe(true)
    expect(getRoundPresence(p, rounds, 1)).toBe(false)
  })

  it('a garbage round pointer clamps before reading', () => {
    const p = { [ATTENDANCE_BY_ROUND_FIELD]: { '1985': 1 } }
    expect(getRoundPresence(p, rounds, 99)).toBe(true)  // clamps to last round (1985)
  })
})
