import { describe, it, expect } from 'vitest'
import { buildScoringRecord } from '../src/flow/makeFinalizeInstance'
import { computeZScoresByRole } from '@mygames/game-engine'
import type { RoleConfig } from '@mygames/game-engine'

// ═══════════════════════════════════════════════════════════════════════════════
// THE PARTICIPATION RULE (Elena, 2026-07-29) — pinned, because it is a GRADING
// contract and it is decided by the instructor's workflow rather than inferred by code.
//
//   IN A GROUP at finalize  → participated. Scored normally, IN the normalization pool.
//   UNGROUPED at finalize   → normalized_score −2, raw_score null, EXCLUDED from the pool.
//   BOT                     → never in the gradebook at all.
//
// The instructor pre-groups the whole roster, then UNGROUPS no-shows (reconstituting
// groups or adding bots) before starting. Ungrouping IS the declaration that someone did
// not participate. The code must not second-guess it — in particular it must NOT try to
// infer participation from arrival, presence, or whether the group ever started.
//
// ⚠ WHY THIS FILE EXISTS WITH NO ACCOMPANYING SOURCE CHANGE. A production smoke showed
// all 17 enrolled students scored `completed` in online mode, and that was reported as a
// possible defect. It is not: online pre-grouping puts everyone in a group, nobody had
// been ungrouped, and under the rule above every grouped student HAS participated. The
// behaviour was already correct end to end. These tests pin it so the next person who
// sees "everyone scored as present" can check the rule instead of changing the engine.
//
// The sharp edge is real, though, and it is a UI problem rather than a scoring one: if
// the instructor forgets to ungroup, no-shows score as participants silently. That is
// addressed at the moment of the decision — see the finalize confirmation and the
// never-started panel on the instructor dashboard.
// ═══════════════════════════════════════════════════════════════════════════════

const ROLES: RoleConfig = { roles: [{ key: 'player', label: 'Player', short: 'P' }] }
const SENSE = { player: 'value' as const }
const rawOf = () => 1   // participation-only: every present player earns the same point

const grouped = (pid: string, groupId = 'g1') => ({ role: 'player', group_id: groupId })
const ungrouped = (pid: string) => ({ role: 'player', group_id: null })

/** The map scoreAndRecord builds: one entry per EXISTING group, whatever its state. */
const completedGroups = new Map([['g1', { outcome: null, agreement_reached: false }]])

describe('buildScoringRecord — group membership is the signal', () => {
  it('IN A GROUP → completed', () => {
    const r = buildScoringRecord('p1', grouped('p1') as never, completedGroups)
    expect(r?.status).toBe('completed')
  })

  it('UNGROUPED (group_id null) → no_show', () => {
    // This is what `moveSeat` with UNGROUP writes: `{ group_id: null, is_lead: false }`.
    const r = buildScoringRecord('p2', ungrouped('p2') as never, completedGroups)
    expect(r?.status).toBe('no_show')
  })

  it('NEVER GROUPED (no group_id key at all) → no_show', () => {
    const r = buildScoringRecord('p3', { role: 'player' } as never, completedGroups)
    expect(r?.status).toBe('no_show')
  })

  it('a group that exists but NEVER STARTED still counts as participation', () => {
    // Deliberate. "Never started" is not the code's business — the instructor decides by
    // ungrouping. A group with no round document is still a group.
    const r = buildScoringRecord('p4', grouped('p4') as never, completedGroups)
    expect(r?.status).toBe('completed')
  })

  it('no role → not scored at all (returns null, never reaches the gradebook)', () => {
    expect(buildScoringRecord('p5', { group_id: 'g1' } as never, completedGroups)).toBeNull()
  })
})

describe('computeZScoresByRole — the ungrouped are −2 AND out of the pool', () => {
  const records = [
    buildScoringRecord('in1', grouped('in1') as never, completedGroups)!,
    buildScoringRecord('in2', grouped('in2') as never, completedGroups)!,
    buildScoringRecord('out1', ungrouped('out1') as never, completedGroups)!,
    buildScoringRecord('out2', ungrouped('out2') as never, completedGroups)!,
  ]
  const finalized = computeZScoresByRole(records, ROLES, SENSE, rawOf)
  const by = (pid: string) => finalized.find((f) => f.participant_id === pid)!

  it('ungrouped students get normalized_score −2', () => {
    expect(by('out1').normalized_score).toBe(-2)
    expect(by('out2').normalized_score).toBe(-2)
  })

  it('ungrouped students get raw_score null', () => {
    expect(by('out1').raw_score).toBeNull()
    expect(by('out2').raw_score).toBeNull()
  })

  it('grouped students are scored normally', () => {
    expect(by('in1').raw_score).toBe(1)
    expect(by('in2').raw_score).toBe(1)
  })

  it('⚠ the ungrouped are EXCLUDED FROM THE POOL — they do not drag the mean', () => {
    // The load-bearing half, and the one a naive implementation gets wrong by scoring
    // absentees 0 and leaving them in. Two participants with identical raw scores must
    // normalize to exactly 0 (zero-SD pool); if the two −2s were in the pool the mean
    // would move and the present students would no longer sit at 0.
    expect(by('in1').normalized_score).toBe(0)
    expect(by('in2').normalized_score).toBe(0)
  })

  it('and the exclusion holds when the present students DIFFER', () => {
    const spread = [
      buildScoringRecord('a', grouped('a') as never, completedGroups)!,
      buildScoringRecord('b', grouped('b') as never, completedGroups)!,
      buildScoringRecord('z', ungrouped('z') as never, completedGroups)!,
    ]
    let n = 0
    const varying = () => (n++ === 0 ? 10 : 20)
    const out = computeZScoresByRole(spread, ROLES, SENSE, varying)
    const zs = out.filter((o) => o.participant_id !== 'z').map((o) => o.normalized_score!)
    // Two points, sample SD → exactly ±1/√2·… whatever the engine's convention, the pair
    // must be symmetric about zero. An absentee inside the pool would break that symmetry.
    expect(zs[0]! + zs[1]!).toBeCloseTo(0, 10)
    expect(out.find((o) => o.participant_id === 'z')!.normalized_score).toBe(-2)
  })
})
