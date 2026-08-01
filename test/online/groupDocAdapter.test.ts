import { describe, it, expect } from 'vitest'
import {
  makeStageGroupAdapter, makeNegotiationGroupAdapter, toSeatGroup,
} from '../../src/online/groupDocAdapter'
import { leadOf, moveOccupant } from '../../src/online/seatOps'
import type { SeatOccupant } from '../../src/online/types'

// The adapter is the piece that has to reconcile two group-doc shapes without a fork
// and without a union type that grows a branch per game. These tests prove the
// reconciliation holds in BOTH directions (read → operate → write) for each family.

const stage = makeStageGroupAdapter()
const negotiation = makeNegotiationGroupAdapter(['winemaster', 'home_base'])

const human = (id: string, role: string | null = null): SeatOccupant =>
  ({ participantId: id, isBot: false, role })

describe('stage adapter', () => {
  const doc = {
    player_participants: ['h1', 'h2', 'bot_1'],
    bot_participants: ['bot_1'],
    bot_count: 1,
    lead_participant_id: 'h1',
    members: [
      { participant_id: 'h1', display_name: 'Ada', email: 'ada@x.edu' },
      { participant_id: 'h2', display_name: 'Bo', email: null },
    ],
    member_logins: { h1: 'T1' },
  }

  it('reads seat order, marks bots, and carries the denormalised names', () => {
    const occ = stage.readOccupants(doc)
    expect(occ.map((o) => o.participantId)).toEqual(['h1', 'h2', 'bot_1'])
    expect(occ.map((o) => o.isBot)).toEqual([false, false, true])
    expect(occ[0].displayName).toBe('Ada')
    expect(occ[0].email).toBe('ada@x.edu')
    expect(occ[0].lastLoginAt).toBe('T1')
    expect(occ[1].email).toBeNull()
  })

  it('reads the per-group lock from seats_locked_at', () => {
    expect(stage.hasStarted(doc)).toBe(false)
    expect(stage.hasStarted({ ...doc, seats_locked_at: 'T' })).toBe(true)
    expect(stage.startedField).toBe('seats_locked_at')
  })

  it('writes back the seat list, the bot list and the recomputed lead', () => {
    const occupants = [human('h2'), human('h3')]
    const patch = stage.writeMembership({ existing: doc, occupants, lead: leadOf({ groupId: 'g', occupants, started: false }) })
    expect(patch.player_participants).toEqual(['h2', 'h3'])
    expect(patch.bot_participants).toEqual([])
    expect(patch.bot_count).toBe(0)
    expect(patch.lead_participant_id).toBe('h2')
  })

  it('maintains members[] only where the group ALREADY has it', () => {
    const occupants = [human('h2')]
    // Online-formed group (has members[]) → maintained.
    expect(stage.writeMembership({ existing: doc, occupants, lead: 'h2' }).members).toBeDefined()
    // Classroom-matched group (no members[]) → never fabricated. Its absence is the
    // very signal the reveal gate keys on, so inventing it would break the gate.
    const classroom = { player_participants: ['h2'], bot_participants: [] }
    expect(stage.writeMembership({ existing: classroom, occupants, lead: 'h2' }).members).toBeUndefined()
  })

  it('a brand-new group always carries members[]', () => {
    const fields = stage.newGroupFields({
      groupId: 'g1', gameInstanceId: 'i1', existing: null,
      occupants: [{ ...human('h1'), displayName: 'Ada', email: 'a@x' }], lead: 'h1', now: 'T',
    })
    expect(fields.members).toEqual([{ participant_id: 'h1', display_name: 'Ada', email: 'a@x' }])
    expect(fields.status).toBe('matched')
    expect(fields.group_id).toBe('g1')
  })

  it('members[] is HUMANS ONLY — a bot is a seat, not a person to email', () => {
    const fields = stage.newGroupFields({
      groupId: 'g', gameInstanceId: 'i', existing: null,
      occupants: [human('h1'), { participantId: 'bot_1', isBot: true }], lead: 'h1', now: 'T',
    })
    expect((fields.members as unknown[])).toHaveLength(1)
    expect(fields.player_participants).toEqual(['h1', 'bot_1'])
    expect(fields.bot_participants).toEqual(['bot_1'])
  })

  it('round-trips: read → move → write lands the right seat list', () => {
    const g = toSeatGroup(stage, 'A', doc)
    const r = moveOccupant({ participantId: 'h2', source: g, target: null, seatCount: 3 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const patch = stage.writeMembership({ existing: doc, occupants: r.source!.occupants, lead: leadOf(r.source!) })
    expect(patch.player_participants).toEqual(['h1', 'bot_1'])
    expect(patch.lead_participant_id).toBe('h1')
  })
})

describe('negotiation adapter (DEFINED, no consumer until late September)', () => {
  const doc = {
    winemaster_participants: ['w1', 'w2'],
    home_base_participants: ['h1', 'h2'],
    lead_participant_id: 'w1',
  }

  it('flattens the per-role arrays into seat occupants, tagged with their role', () => {
    const occ = negotiation.readOccupants(doc)
    expect(occ.map((o) => o.participantId)).toEqual(['w1', 'w2', 'h1', 'h2'])
    expect(occ.map((o) => o.role)).toEqual(['winemaster', 'winemaster', 'home_base', 'home_base'])
    // No bots in this family.
    expect(occ.every((o) => !o.isBot)).toBe(true)
  })

  it('reads the per-group lock from the negotiation lifecycle, not a seat lock', () => {
    expect(negotiation.hasStarted(doc)).toBe(false)
    expect(negotiation.hasStarted({ ...doc, negotiation_started_at: 'T' })).toBe(true)
    expect(negotiation.hasStarted({ ...doc, status: 'negotiating' })).toBe(true)
    expect(negotiation.startedField).toBe('negotiation_started_at')
  })

  it('partitions occupants back into per-role arrays on write', () => {
    const occupants = [human('w1', 'winemaster'), human('h1', 'home_base'), human('h3', 'home_base')]
    const patch = negotiation.writeMembership({ existing: doc, occupants, lead: 'w1' })
    expect(patch.winemaster_participants).toEqual(['w1'])
    expect(patch.home_base_participants).toEqual(['h1', 'h3'])
    expect(patch.lead_participant_id).toBe('w1')
  })

  it('EMPTIES a role array that lost its last occupant', () => {
    // The trap: writing only the roles that still have people would leave the old
    // occupant in place, and the participant would be in two groups at once.
    const occupants = [human('h1', 'home_base')]
    const patch = negotiation.writeMembership({ existing: doc, occupants, lead: 'h1' })
    expect(patch.winemaster_participants).toEqual([])
  })

  it('a move preserves the mover’s ROLE — a Chris moved anywhere is still a Chris', () => {
    const source = toSeatGroup(negotiation, 'A', doc)
    const target = toSeatGroup(negotiation, 'B', { winemaster_participants: ['w9'], home_base_participants: [] })
    const r = moveOccupant({ participantId: 'h1', source, target, seatCount: 4 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const patch = negotiation.writeMembership({ existing: {}, occupants: r.target!.occupants, lead: 'w9' })
    expect(patch.home_base_participants).toEqual(['h1'])
    expect(patch.winemaster_participants).toEqual(['w9'])
  })

  it('touches NOTHING of the negotiation bookkeeping', () => {
    // lead_outcome / lead_reported_at / confirmations / reset_count / completed_at /
    // outcomes_by_round are untouched by every seat operation, which is exactly why
    // they never had to appear in the adapter interface.
    const rich = {
      ...doc,
      lead_outcome: { wage: 10 }, lead_reported_at: 'T', reset_count: 2,
      confirmations: { w1: 'confirmed' }, completed_at: null, outcomes_by_round: { '1978': {} },
    }
    const patch = negotiation.writeMembership({
      existing: rich, occupants: negotiation.readOccupants(rich), lead: 'w1',
    })
    for (const k of ['lead_outcome', 'lead_reported_at', 'reset_count', 'confirmations', 'completed_at', 'outcomes_by_round']) {
      expect(Object.prototype.hasOwnProperty.call(patch, k)).toBe(false)
    }
  })
})

// ── round-aware started override (baxter is the one consumer) ─────────────────

describe('negotiation adapter — optional hasStarted override', () => {
  const doc = { winemaster_participants: ['w1'], home_base_participants: ['h1'] }

  it('with no override, the DEFAULT lock is unchanged (five single-round games)', () => {
    const a = makeNegotiationGroupAdapter(['winemaster', 'home_base'])
    expect(a.hasStarted(doc)).toBe(false)
    expect(a.hasStarted({ ...doc, negotiation_started_at: 'T' })).toBe(true)
    expect(a.hasStarted({ ...doc, status: 'negotiating' })).toBe(true)
  })

  // Baxter's status-based predicate: locked only while ACTIVELY mid-round.
  const baxterHasStarted = (g: Record<string, unknown>) =>
    g['status'] === 'negotiating' || g['status'] === 'reporting'

  it('an override replaces the default predicate entirely', () => {
    const a = makeNegotiationGroupAdapter(['baxter', 'union'], { hasStarted: baxterHasStarted })
    expect(a.hasStarted({ status: 'matched' })).toBe(false)      // fresh → movable
    expect(a.hasStarted({ status: 'negotiating' })).toBe(true)   // active → locked
    expect(a.hasStarted({ status: 'reporting' })).toBe(true)     // deal reported, confirming → locked
    expect(a.hasStarted({ status: 'completed' })).toBe(false)    // resolved → movable
    expect(a.hasStarted({ status: 'deadlocked' })).toBe(false)   // degenerate day-2 → movable
  })

  it('the override does NOT permalock on the sticky re-stamped field (the whole point)', () => {
    const a = makeNegotiationGroupAdapter(['baxter', 'union'], { hasStarted: baxterHasStarted })
    // Baxter re-stamps negotiation_started_at every round and never clears it. The DEFAULT
    // would return true forever; the status-based override tracks the live round instead.
    const restamped = { negotiation_started_at: 'T', status: 'completed' }
    expect(makeNegotiationGroupAdapter(['baxter', 'union']).hasStarted(restamped)).toBe(true)  // default: locked forever
    expect(a.hasStarted(restamped)).toBe(false)                                                // override: between-rounds → movable
  })

  it('the override flows through toSeatGroup.started', () => {
    const a = makeNegotiationGroupAdapter(['baxter', 'union'], { hasStarted: baxterHasStarted })
    expect(toSeatGroup(a, 'G', { status: 'negotiating', negotiation_started_at: 'T' }).started).toBe(true)
    expect(toSeatGroup(a, 'G', { status: 'completed', negotiation_started_at: 'T' }).started).toBe(false)
  })
})

describe('the two families share one seat machinery', () => {
  it('the SAME move operation drives both adapters', () => {
    // The reconciliation in one test: seatOps never learns which family it is in.
    const stageGroup = toSeatGroup(stage, 'S', { player_participants: ['a', 'b'], bot_participants: [] })
    const negGroup = toSeatGroup(negotiation, 'N', { winemaster_participants: ['a'], home_base_participants: ['b'] })

    for (const g of [stageGroup, negGroup]) {
      const r = moveOccupant({ participantId: 'a', source: g, target: null, seatCount: 2 })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.source!.occupants.map((o) => o.participantId)).toEqual(['b'])
    }
  })

  it('both report a per-group lock through the same predicate', () => {
    expect(toSeatGroup(stage, 'S', { seats_locked_at: 'T' }).started).toBe(true)
    expect(toSeatGroup(negotiation, 'N', { negotiation_started_at: 'T' }).started).toBe(true)
  })
})

// ── §2.1.1 item B: arrival data present vs absent ─────────────────────────────

describe('arrival data — missing must be distinguishable from empty', () => {
  it('GROUP CREATION initialises arrived[] — the fix for the false alarm', () => {
    // Without this, the field only appears on a student's FIRST arrival (arrayUnion),
    // so a freshly pre-grouped instance — the normal state of an online assignment,
    // where the whole point is that students arrive later — has no key at all and the
    // report wrongly announces "this game is not writing arrived[]".
    const fields = stage.newGroupFields({
      groupId: 'g', gameInstanceId: 'i', existing: null,
      occupants: [human('h1'), human('h2')], lead: 'h1', now: 'T',
    })
    expect(Object.prototype.hasOwnProperty.call(fields, 'arrived')).toBe(true)
    expect(fields.arrived).toEqual([])
  })

  it('a group created by the shared path therefore reports DATA, not "not recorded"', () => {
    const fields = stage.newGroupFields({
      groupId: 'g', gameInstanceId: 'i', existing: null,
      occupants: [human('h1')], lead: 'h1', now: 'T',
    })
    // This is exactly what makeGetOnlineReport keys on.
    expect(Object.prototype.hasOwnProperty.call(fields, 'arrived')).toBe(true)
  })

  it('a seat MOVE never fabricates arrived[] on a group that lacks it', () => {
    // writeMembership must not paper over an unwired game — the signal has to stay
    // truthful for a game that creates its groups outside the shared path.
    const patch = stage.writeMembership({
      existing: { player_participants: ['h1'], bot_participants: [] },
      occupants: [human('h1')], lead: 'h1',
    })
    expect(Object.prototype.hasOwnProperty.call(patch, 'arrived')).toBe(false)
  })

  // The report's rule, isolated: `arrivalDataPresent` keys on the PRESENCE of the
  // `arrived` field, not on the emptiness of the set. A game that writes
  // `arrived: []` and genuinely had nobody turn up is reporting real data; a game
  // that never writes the field at all is a wiring gap.
  const present = (doc: Record<string, unknown>) =>
    Object.prototype.hasOwnProperty.call(doc, 'arrived')

  it('a group that never wrote arrived[] reports NO DATA', () => {
    expect(present({ player_participants: ['a'] })).toBe(false)
  })

  it('a group that wrote an EMPTY arrived[] reports DATA — nobody came', () => {
    expect(present({ player_participants: ['a'], arrived: [] })).toBe(true)
  })

  it('a group with arrivals reports data', () => {
    expect(present({ player_participants: ['a'], arrived: ['a'] })).toBe(true)
  })
})
