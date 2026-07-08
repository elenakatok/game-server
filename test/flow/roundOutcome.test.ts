import { describe, it, expect } from 'vitest'
import {
  ROUND_OUTCOMES_FIELD,
  clampRoundIndex,
  resolveRoundSlot,
  getRoundOutcome,
  setRoundOutcome,
} from '../../src/flow/roundOutcome'

// ── clampRoundIndex ─────────────────────────────────────────────────────────────

describe('clampRoundIndex', () => {
  it('returns 0 for an empty round list', () => {
    expect(clampRoundIndex(0, 3)).toBe(0)
    expect(clampRoundIndex(0, undefined)).toBe(0)
  })

  it('defaults a missing / non-integer pointer to 0', () => {
    expect(clampRoundIndex(3, undefined)).toBe(0)
    expect(clampRoundIndex(3, null)).toBe(0)
    expect(clampRoundIndex(3, 1.5)).toBe(0)
    expect(clampRoundIndex(3, 'x')).toBe(0)
  })

  it('pins a valid pointer into [0, len-1]', () => {
    expect(clampRoundIndex(3, 0)).toBe(0)
    expect(clampRoundIndex(3, 2)).toBe(2)
    expect(clampRoundIndex(3, 9)).toBe(2)
    expect(clampRoundIndex(3, -4)).toBe(0)
  })
})

// ── resolveRoundSlot ───────────────────────────────────────────────────────────

describe('resolveRoundSlot', () => {
  const rounds = ['1978', '1983', '1985']

  it('one-shot game (no rounds) is always flat', () => {
    expect(resolveRoundSlot(undefined, 0)).toEqual({ kind: 'flat' })
    expect(resolveRoundSlot([], 0)).toEqual({ kind: 'flat' })
    expect(resolveRoundSlot(undefined, 7)).toEqual({ kind: 'flat' })
  })

  it('round 1 (index 0) is flat', () => {
    expect(resolveRoundSlot(rounds, 0)).toEqual({ kind: 'flat' })
  })

  it('rounds 2+ are keyed by round id', () => {
    expect(resolveRoundSlot(rounds, 1)).toEqual({ kind: 'keyed', roundId: '1983' })
    expect(resolveRoundSlot(rounds, 2)).toEqual({ kind: 'keyed', roundId: '1985' })
  })

  it('clamps a garbage pointer before mapping', () => {
    expect(resolveRoundSlot(rounds, 99)).toEqual({ kind: 'keyed', roundId: '1985' })
    expect(resolveRoundSlot(rounds, undefined)).toEqual({ kind: 'flat' })
    expect(resolveRoundSlot(rounds, -1)).toEqual({ kind: 'flat' })
  })
})

// ── getRoundOutcome (Option-1 derive) ──────────────────────────────────────────

describe('getRoundOutcome', () => {
  it('flat slot reads the existing top-level outcome', () => {
    const group = { outcome: { wages: 'current' } }
    expect(getRoundOutcome(group, { kind: 'flat' })).toEqual({ wages: 'current' })
  })

  it('flat slot derives null when there is no outcome (no deal / unset)', () => {
    expect(getRoundOutcome({ outcome: null }, { kind: 'flat' })).toBeNull()
    expect(getRoundOutcome({}, { kind: 'flat' })).toBeNull()
  })

  it('keyed slot reads its round from the map', () => {
    const group = {
      outcome: { wages: 'current' }, // round 1, untouched
      [ROUND_OUTCOMES_FIELD]: { '1983': { wage: 11.5 }, '1985': { wage: 13 } },
    }
    expect(getRoundOutcome(group, { kind: 'keyed', roundId: '1983' })).toEqual({ wage: 11.5 })
    expect(getRoundOutcome(group, { kind: 'keyed', roundId: '1985' })).toEqual({ wage: 13 })
  })

  it('keyed slot derives null for an unset round (no map, or missing key)', () => {
    expect(getRoundOutcome({}, { kind: 'keyed', roundId: '1983' })).toBeNull()
    expect(
      getRoundOutcome({ [ROUND_OUTCOMES_FIELD]: { '1985': { wage: 13 } } }, { kind: 'keyed', roundId: '1983' }),
    ).toBeNull()
  })
})

// ── setRoundOutcome (patch builder) ────────────────────────────────────────────

describe('setRoundOutcome', () => {
  it('flat slot writes the existing top-level fields (byte-identical to before)', () => {
    expect(setRoundOutcome({ kind: 'flat' }, { wages: 'current' })).toEqual({
      outcome: { wages: 'current' },
      agreement_reached: true,
    })
  })

  it('flat no-deal sets outcome null and agreement_reached false', () => {
    expect(setRoundOutcome({ kind: 'flat' }, null)).toEqual({
      outcome: null,
      agreement_reached: false,
    })
  })

  it('keyed slot writes only the dotted round key — never the flat field', () => {
    const patch = setRoundOutcome({ kind: 'keyed', roundId: '1983' }, { wage: 11.5 })
    expect(patch).toEqual({ 'outcomes_by_round.1983': { wage: 11.5 } })
    expect(patch).not.toHaveProperty('outcome')
    expect(patch).not.toHaveProperty('agreement_reached')
  })

  it('keyed no-deal writes null to just that round key', () => {
    expect(setRoundOutcome({ kind: 'keyed', roundId: '1983' }, null)).toEqual({
      'outcomes_by_round.1983': null,
    })
  })

  it('a keyed write patch cannot clobber a sibling round', () => {
    // The dotted-path patch only names round 1983; applied over a doc holding 1985,
    // 1985 is untouched (Firestore semantics; asserted here on the patch shape).
    const patch = setRoundOutcome({ kind: 'keyed', roundId: '1983' }, { wage: 11.5 })
    expect(Object.keys(patch)).toEqual(['outcomes_by_round.1983'])
  })
})
