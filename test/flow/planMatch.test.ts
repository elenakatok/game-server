// planMatch — the pre-match preview arithmetic (makeTriggerMatching). It must agree
// with what matchParticipants actually forms, so each case is checked against both.
import { describe, it, expect } from 'vitest'
import { matchParticipants, fieldFor, mulberry32 } from '@mygames/game-engine'
import { planMatch, type MatchCandidate } from '../../src/flow/makeTriggerMatching'
import type { GameDefinition } from '../../src/GameDefinition'

const roles: GameDefinition['roles'] = {
  roles: [{ key: 'chris', label: 'Chris', short: 'C' }, { key: 'kelly', label: 'Kelly', short: 'K' }],
}
const pair = { roles, composition: { chris: 1, kelly: 1 } }
const pool = (c: number, k: number): MatchCandidate[] => [
  ...Array.from({ length: c }, (_, i) => ({ participant_id: `c${i}`, role: 'chris' })),
  ...Array.from({ length: k }, (_, i) => ({ participant_id: `k${i}`, role: 'kelly' })),
]

describe('planMatch', () => {
  it('5 + 5 → 5 complete pairs, no extras (the 2026-10-05 class, had everyone been counted)', () => {
    expect(planMatch(pool(5, 5), pair)).toEqual({
      confirmed: 10, by_role: { chris: 5, kelly: 5 }, groups: 5, extras_by_role: { chris: 0, kelly: 0 }, feasible: true,
    })
  })

  it('5 + 4 → 4 pairs and ONE extra Chris (what the class actually got)', () => {
    const plan = planMatch(pool(5, 4), pair)
    expect(plan.groups).toBe(4)
    expect(plan.extras_by_role).toEqual({ chris: 1, kelly: 0 })
  })

  it('a role with nobody → not feasible, zero groups', () => {
    const plan = planMatch(pool(3, 0), pair)
    expect(plan.feasible).toBe(false)
    expect(plan.groups).toBe(0)
  })

  it('2-per-role composition: 5 + 4 → 2 groups, extras 1 and 0', () => {
    const plan = planMatch(pool(5, 4), { roles, composition: { chris: 2, kelly: 2 } })
    expect(plan.groups).toBe(2)
    expect(plan.extras_by_role).toEqual({ chris: 1, kelly: 0 })
  })

  it('remnant group is counted and consumes its members', () => {
    const def = { roles, composition: { chris: 2, kelly: 2 }, remnantGroup: { composition: { chris: 1, kelly: 1 } } }
    const plan = planMatch(pool(3, 3), def)
    expect(plan.groups).toBe(2)                       // one 2+2, one 1+1 remnant
    expect(plan.extras_by_role).toEqual({ chris: 0, kelly: 0 })
  })

  it.each([[5, 5], [5, 4], [7, 3], [2, 6], [9, 9]])('agrees with matchParticipants for %i + %i', (c, k) => {
    const eligible = pool(c, k)
    const plan = planMatch(eligible, pair)
    const formed = matchParticipants(eligible, {
      roleConfig: roles, composition: pair.composition, perRoleCap: eligible.length, rng: mulberry32(7),
    })
    expect(formed.length).toBe(plan.groups)
    const placed = formed.reduce((n, g) =>
      n + (g[fieldFor('chris', 'participants')] as string[]).length + (g[fieldFor('kelly', 'participants')] as string[]).length, 0)
    expect(placed).toBe(plan.confirmed)               // every confirmed student lands in a group
    // No group takes an extra while another role's pair is still unfilled: every group has both roles.
    for (const g of formed) {
      expect((g[fieldFor('chris', 'participants')] as string[]).length).toBeGreaterThanOrEqual(1)
      expect((g[fieldFor('kelly', 'participants')] as string[]).length).toBeGreaterThanOrEqual(1)
    }
  })
})
