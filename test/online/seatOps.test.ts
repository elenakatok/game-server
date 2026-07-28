import { describe, it, expect } from 'vitest'
import {
  moveOccupant, ungroupOccupant, fillWithBots, chunkIntoGroups,
  leadOf, isFull, freeSeats, canAcceptHuman,
  checkSeatingInvariants, populationOf,
  type SeatingPlan,
} from '../../src/online/seatOps'
import type { SeatGroup, SeatOccupant } from '../../src/online/types'

// ═══════════════════════════════════════════════════════════════════════════════
// THE MOVE/UNGROUP INVARIANTS — the operations that corrupt data if they are wrong.
//
// Everything here is exercised at n=2 AND n=3, because the machinery has to work for
// Info Sharing (2), Crisis (3) and SAA (7), and a rule that only holds at one seat
// count is not a rule.
// ═══════════════════════════════════════════════════════════════════════════════

const human = (id: string): SeatOccupant => ({ participantId: id, isBot: false, role: null })
const bot = (id: string): SeatOccupant => ({ participantId: id, isBot: true, role: null })

const group = (id: string, occupants: SeatOccupant[], started = false): SeatGroup =>
  ({ groupId: id, occupants, started })

/** Apply a successful move to a whole plan, so invariants can be checked over it. */
function applyMove(plan: SeatingPlan, participantId: string, targetGroupId: string | null, seatCount: number): SeatingPlan {
  const source = plan.groups.find((g) => g.occupants.some((o) => o.participantId === participantId)) ?? null
  const target = targetGroupId ? plan.groups.find((g) => g.groupId === targetGroupId) ?? null : null
  const pooled = plan.unassigned.find((o) => o.participantId === participantId)

  const r = moveOccupant({ participantId, source, target, seatCount, occupant: pooled })
  if (!r.ok) throw new Error(r.reason)

  const byId = new Map(plan.groups.map((g) => [g.groupId, g]))
  if (r.source) byId.set(r.source.groupId, r.source)
  if (r.target) byId.set(r.target.groupId, r.target)

  // An evicted bot leaves the world entirely; a displaced HUMAN would go to the pool.
  let unassigned = plan.unassigned.filter((o) => o.participantId !== participantId)
  if (!r.target) {
    const moved = source?.occupants.find((o) => o.participantId === participantId) ?? pooled
    if (moved) unassigned = [...unassigned, moved]
  }
  return { groups: [...byId.values()], unassigned }
}

// ── invariant 1: never in two groups ───────────────────────────────────────────

describe('a participant is never in two groups', () => {
  for (const n of [2, 3]) {
    it(`holds across a chain of moves at n=${n}`, () => {
      let plan: SeatingPlan = {
        groups: [
          group('A', [human('a1'), human('a2')].slice(0, n)),
          group('B', [human('b1')]),
          group('C', []),
        ],
        unassigned: [human('pool1')],
      }
      expect(checkSeatingInvariants(plan, n)).toEqual([])

      plan = applyMove(plan, 'b1', 'C', n)
      expect(checkSeatingInvariants(plan, n)).toEqual([])
      plan = applyMove(plan, 'pool1', 'B', n)
      expect(checkSeatingInvariants(plan, n)).toEqual([])
      plan = applyMove(plan, 'b1', 'B', n)
      expect(checkSeatingInvariants(plan, n)).toEqual([])

      // 'b1' appears exactly once, in B.
      const holders = plan.groups.filter((g) => g.occupants.some((o) => o.participantId === 'b1'))
      expect(holders.map((g) => g.groupId)).toEqual(['B'])
    })
  }

  it('the invariant checker actually CATCHES a double membership', () => {
    // Guard against a vacuous checker: it must fail on a plan that is genuinely wrong.
    const broken: SeatingPlan = {
      groups: [group('A', [human('x')]), group('B', [human('x')])],
      unassigned: [],
    }
    const v = checkSeatingInvariants(broken, 3)
    expect(v.map((x) => x.invariant)).toContain('a participant is never in two groups')
  })

  it('the checker catches a participant both grouped and pooled', () => {
    const broken: SeatingPlan = { groups: [group('A', [human('x')])], unassigned: [human('x')] }
    expect(checkSeatingInvariants(broken, 3).map((x) => x.invariant))
      .toContain('a participant is never both grouped and unassigned')
  })

  it('the checker catches an over-full group', () => {
    const broken: SeatingPlan = { groups: [group('A', [human('a'), human('b'), human('c')])], unassigned: [] }
    expect(checkSeatingInvariants(broken, 2).map((x) => x.invariant))
      .toContain('group never exceeds seatCount')
  })
})

// ── invariant 2: never lost ────────────────────────────────────────────────────

describe('a participant is never lost — ungrouped is a STATE, not an absence', () => {
  for (const n of [2, 3]) {
    it(`the population is conserved across move and ungroup at n=${n}`, () => {
      let plan: SeatingPlan = {
        groups: [group('A', [human('a1'), human('a2')]), group('B', [])],
        unassigned: [human('pool1')],
      }
      const before = populationOf(plan)

      plan = applyMove(plan, 'a1', null, n)      // ungroup
      expect(populationOf(plan)).toEqual(before)
      expect(plan.unassigned.map((o) => o.participantId).sort()).toEqual(['a1', 'pool1'])

      plan = applyMove(plan, 'a1', 'B', n)       // and back in from the pool
      expect(populationOf(plan)).toEqual(before)
      expect(plan.unassigned.map((o) => o.participantId)).toEqual(['pool1'])
      expect(checkSeatingInvariants(plan, n)).toEqual([])
    })
  }

  it('an ungrouped participant can always be placed again', () => {
    const source = group('A', [human('x')])
    const r = ungroupOccupant({ participantId: 'x', source, seatCount: 3 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // They are gone from the group but the occupant object survives for re-placement.
    expect(r.source?.occupants).toEqual([])
    const back = moveOccupant({
      participantId: 'x', source: null, target: group('B', []), seatCount: 3, occupant: human('x'),
    })
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.target?.occupants.map((o) => o.participantId)).toEqual(['x'])
  })

  it('a bot is never put in the No Group pool — the checker says so', () => {
    const broken: SeatingPlan = { groups: [], unassigned: [bot('bot_1')] }
    expect(checkSeatingInvariants(broken, 3).map((x) => x.invariant))
      .toContain('a bot is never in the No Group pool')
  })
})

// ── invariant 3: ungroup leaves the group standing ─────────────────────────────

describe('ungroup leaves the group STANDING with a free seat', () => {
  for (const n of [2, 3]) {
    it(`at n=${n}`, () => {
      const source = group('A', Array.from({ length: n }, (_, i) => human(`a${i}`)))
      const r = ungroupOccupant({ participantId: 'a0', source, seatCount: n })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.source).not.toBeNull()
      expect(r.source!.groupId).toBe('A')
      expect(r.source!.occupants).toHaveLength(n - 1)
      expect(freeSeats(r.source!, n)).toBe(1)
    })
  }

  it('a group emptied to zero still exists — it is not deleted', () => {
    const r = ungroupOccupant({ participantId: 'only', source: group('A', [human('only')]), seatCount: 2 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.source).not.toBeNull()
    expect(r.source!.occupants).toEqual([])
    // …and it can be filled again.
    expect(canAcceptHuman(r.source!, 2)).toBe(true)
  })

  it('the lead is recomputed over whoever remains, and is never a bot', () => {
    const source = group('A', [human('a'), bot('bot_1'), human('c')])
    const r = ungroupOccupant({ participantId: 'a', source, seatCount: 3 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(leadOf(r.source!)).toBe('c')
  })

  it('an all-bot group has no lead rather than a bot lead', () => {
    expect(leadOf(group('A', [bot('b1'), bot('b2')]))).toBeNull()
  })
})

// ── invariant 4: human evicts bot; bot never evicts human ──────────────────────

describe('a human moving in evicts a BOT; a bot never evicts a human', () => {
  for (const n of [2, 3]) {
    it(`a human takes a bot's seat in a full group at n=${n}`, () => {
      const bots = Array.from({ length: n - 1 }, (_, i) => bot(`bot_${i + 1}`))
      const target = group('B', [human('b0'), ...bots])
      expect(isFull(target, n)).toBe(true)

      const r = moveOccupant({
        participantId: 'x', source: group('A', [human('x')]), target, seatCount: n, occupant: human('x'),
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.evictedBot).toBe(`bot_${n - 1}`) // the LAST-ADDED bot
      expect(r.target!.occupants).toHaveLength(n)
      expect(r.target!.occupants.some((o) => o.participantId === 'x')).toBe(true)
      expect(r.target!.occupants.some((o) => o.participantId === r.evictedBot)).toBe(false)
      // No human was displaced.
      expect(r.target!.occupants.some((o) => o.participantId === 'b0')).toBe(true)
    })

    it(`a FULL ALL-HUMAN group is genuinely full at n=${n}`, () => {
      const target = group('B', Array.from({ length: n }, (_, i) => human(`b${i}`)))
      const r = moveOccupant({
        participantId: 'x', source: group('A', [human('x')]), target, seatCount: n, occupant: human('x'),
      })
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toContain(`already full (${n} human seats)`)
      expect(canAcceptHuman(target, n)).toBe(false)
    })
  }

  it('a BOT can never be moved at all — so it can never evict anyone', () => {
    const r = moveOccupant({
      participantId: 'bot_1',
      source: group('A', [bot('bot_1')]),
      target: group('B', []),
      seatCount: 3,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('Only human participants can be moved')
  })

  it('a group with a free seat takes the human WITHOUT evicting anything', () => {
    const target = group('B', [human('b0'), bot('bot_1')])
    const r = moveOccupant({
      participantId: 'x', source: null, target, seatCount: 3, occupant: human('x'),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.evictedBot).toBeNull()
    expect(r.target!.occupants).toHaveLength(3)
  })
})

// ── invariant 5: per-group locks ───────────────────────────────────────────────

describe('per-group locks freeze that group only', () => {
  it('move INTO a started group is refused', () => {
    const r = moveOccupant({
      participantId: 'x',
      source: group('A', [human('x')]),
      target: group('B', [], true),
      seatCount: 3,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('destination group has already started')
  })

  it('move OUT of a started group is refused', () => {
    const r = moveOccupant({
      participantId: 'x',
      source: group('A', [human('x')], true),
      target: group('B', []),
      seatCount: 3,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('source group has already started')
  })

  it('UNGROUP out of a started group is refused too', () => {
    const r = ungroupOccupant({ participantId: 'x', source: group('A', [human('x')], true), seatCount: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('source group has already started')
  })

  it('bot-fill of a started group is refused', () => {
    const r = fillWithBots({ group: group('A', [human('x')], true), seatCount: 3, mint: () => bot('b') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('already started playing')
  })

  it('A STARTED GROUP DOES NOT BLOCK A DIFFERENT GROUP — the whole point', () => {
    // Group A is mid-game. The instructor must still be able to rearrange B and C.
    const started = group('A', [human('a1'), human('a2'), human('a3')], true)
    const b = group('B', [human('b1')])
    const c = group('C', [])

    const move = moveOccupant({ participantId: 'b1', source: b, target: c, seatCount: 3 })
    expect(move.ok).toBe(true)

    const fill = fillWithBots({ group: c, seatCount: 3, mint: (i) => bot(`bot_${i}`) })
    expect(fill.ok).toBe(true)

    const ungroup = ungroupOccupant({ participantId: 'b1', source: b, seatCount: 3 })
    expect(ungroup.ok).toBe(true)

    // …and A is untouched by any of it.
    expect(started.occupants).toHaveLength(3)
    expect(started.started).toBe(true)
  })

  it('canAcceptHuman is FALSE for a started group and TRUE for an open one', () => {
    expect(canAcceptHuman(group('A', [], true), 3)).toBe(false)
    expect(canAcceptHuman(group('B', []), 3)).toBe(true)
  })
})

// ── the O2.1 visibility trap, as a pure predicate ──────────────────────────────

describe('availability is PER GROUP, never "a free seat exists somewhere"', () => {
  it('a full class of full groups still accepts a human wherever a bot sits', () => {
    // The recorded O2.1 bug: controls were gated on a global "is there a free seat",
    // true in short-group seed data and false for a real full class, so every control
    // rendered as an empty span. Availability must be asked of each group.
    const n = 3
    const groups = [
      group('A', [human('a1'), human('a2'), human('a3')]),      // genuinely full
      group('B', [human('b1'), human('b2'), bot('bot_1')]),     // full, but bot-backed
    ]
    expect(groups.every((g) => isFull(g, n))).toBe(true)        // no free seat anywhere
    expect(canAcceptHuman(groups[0], n)).toBe(false)
    expect(canAcceptHuman(groups[1], n)).toBe(true)             // ← still a destination
  })
})

// ── bot fill and chunking ──────────────────────────────────────────────────────

describe('fillWithBots', () => {
  for (const n of [2, 3]) {
    it(`fills exactly the empty seats at n=${n}`, () => {
      const r = fillWithBots({ group: group('A', [human('a')]), seatCount: n, mint: (i) => bot(`bot_${i}`) })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.added).toHaveLength(n - 1)
      expect(r.group.occupants).toHaveLength(n)
      // Bots take the TRAILING seats, so eviction order and human seat order are stable.
      expect(r.group.occupants[0].participantId).toBe('a')
      expect(r.group.occupants.slice(1).every((o) => o.isBot)).toBe(true)
    })
  }

  it('a full group is a no-op, not an error', () => {
    const r = fillWithBots({ group: group('A', [human('a'), human('b')]), seatCount: 2, mint: () => bot('x') })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.added).toEqual([])
  })

  it('bot indices continue past existing bots', () => {
    const r = fillWithBots({ group: group('A', [human('a'), bot('bot_1')]), seatCount: 3, mint: (i) => bot(`bot_${i}`) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.added.map((o) => o.participantId)).toEqual(['bot_2'])
  })

  it('a one-human group is ALLOWED — no lower bound (Online_Matching_Spec §5)', () => {
    const r = fillWithBots({ group: group('A', [human('a')]), seatCount: 3, mint: (i) => bot(`bot_${i}`) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.group.occupants.filter((o) => !o.isBot)).toHaveLength(1)
  })
})

describe('chunkIntoGroups', () => {
  it('splits into full groups with ONE short remainder', () => {
    expect(chunkIntoGroups([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([[1, 2, 3], [4, 5, 6], [7]])
    expect(chunkIntoGroups([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('an exact multiple leaves no remainder', () => {
    expect(chunkIntoGroups([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })
  it('never discards anyone', () => {
    for (const n of [2, 3, 7]) {
      const roster = Array.from({ length: 17 }, (_, i) => i)
      expect(chunkIntoGroups(roster, n).flat().sort((a, b) => a - b)).toEqual(roster)
    }
  })
  it('refuses a nonsense seat count', () => {
    expect(() => chunkIntoGroups([1], 0)).toThrow(/seatCount must be >= 1/)
  })
})

// ── idempotence ────────────────────────────────────────────────────────────────

describe('a repeated move is a no-op, not a corruption', () => {
  it('moving someone into the group they are already in changes nothing', () => {
    const g = group('A', [human('x')])
    const r = moveOccupant({ participantId: 'x', source: g, target: g, seatCount: 3 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.noop).toBe(true)
    expect(r.source!.occupants.map((o) => o.participantId)).toEqual(['x'])
  })

  it('ungrouping someone who has no group changes nothing', () => {
    const r = ungroupOccupant({ participantId: 'x', source: null, seatCount: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.noop).toBe(true)
  })
})
