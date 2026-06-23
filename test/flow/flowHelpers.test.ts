import { describe, it, expect } from 'vitest'
import { resolvePerRoleCap } from '../../src/flow/makeTriggerMatching'
import { resolveDeadlockThreshold } from '../../src/flow/makeSubmitConfirmation'
import { buildScoringRecord, type CompletedGroup } from '../../src/flow/makeFinalizeInstance'

// ── resolvePerRoleCap ──────────────────────────────────────────────────────────

describe('resolvePerRoleCap', () => {
  it('returns def.perRoleCap when defined', () => {
    expect(resolvePerRoleCap(2, 20)).toBe(2)
    expect(resolvePerRoleCap(0, 10)).toBe(0)
  })

  it('falls back to eligibleCount when perRoleCap is absent (unlimited cap)', () => {
    expect(resolvePerRoleCap(undefined, 42)).toBe(42)
    expect(resolvePerRoleCap(undefined, 0)).toBe(0)
    expect(resolvePerRoleCap(undefined, 1)).toBe(1)
  })
})

// ── resolveDeadlockThreshold ───────────────────────────────────────────────────

describe('resolveDeadlockThreshold', () => {
  it('returns the threshold when defined', () => {
    expect(resolveDeadlockThreshold(3)).toBe(3)
    expect(resolveDeadlockThreshold(10)).toBe(10)
    expect(resolveDeadlockThreshold(1)).toBe(1)
  })

  it('defaults to 5 when absent', () => {
    expect(resolveDeadlockThreshold(undefined)).toBe(5)
  })
})

// ── buildScoringRecord ─────────────────────────────────────────────────────────

const completedGroups = new Map<string, CompletedGroup>([
  ['g-deal', { outcome: { shares: 150000, vesting: 'Immediate', board_seat: true, liability: 0 }, agreement_reached: true }],
  ['g-walkaway', { outcome: null, agreement_reached: false }],
])

describe('buildScoringRecord — no-role participants', () => {
  it('returns null when role is absent', () => {
    expect(buildScoringRecord('p1', {}, completedGroups)).toBeNull()
  })

  it('returns null when role is null', () => {
    expect(buildScoringRecord('p1', { role: null }, completedGroups)).toBeNull()
  })

  it('returns null when role is empty string', () => {
    // empty string is falsy → treated as no role
    expect(buildScoringRecord('p1', { role: '' }, completedGroups)).toBeNull()
  })
})

describe('buildScoringRecord — completed participants', () => {
  it('classifies a deal correctly', () => {
    const r = buildScoringRecord('p1', {
      role: 'winemaster',
      group_id: 'g-deal',
      knowledge_check_score: 0.75,
    }, completedGroups)
    expect(r?.status).toBe('completed')
    expect(r?.agreement_reached).toBe(true)
    expect(r?.outcome).toEqual({ shares: 150000, vesting: 'Immediate', board_seat: true, liability: 0 })
    expect(r?.knowledge_check_score).toBe(0.75)
  })

  it('classifies a walk-away (no deal) as completed', () => {
    const r = buildScoringRecord('p2', {
      role: 'home_base',
      group_id: 'g-walkaway',
    }, completedGroups)
    expect(r?.status).toBe('completed')
    expect(r?.agreement_reached).toBe(false)
    expect(r?.outcome).toBeNull()
  })
})

describe('buildScoringRecord — late participants', () => {
  it('classifies participant_late: true as late', () => {
    const r = buildScoringRecord('p3', {
      role: 'winemaster',
      participant_late: true,
    }, completedGroups)
    expect(r?.status).toBe('late')
    expect(r?.agreement_reached).toBe(false)
    expect(r?.outcome).toBeNull()
  })

  it('late beats no_show when group_id is also absent', () => {
    const r = buildScoringRecord('p3', {
      role: 'home_base',
      group_id: undefined,
      participant_late: true,
    }, completedGroups)
    expect(r?.status).toBe('late')
  })

  it('completed group takes priority over participant_late', () => {
    // If somehow both flags are set, the group outcome wins.
    const r = buildScoringRecord('p3', {
      role: 'winemaster',
      group_id: 'g-deal',
      participant_late: true,
    }, completedGroups)
    expect(r?.status).toBe('completed')
  })
})

describe('buildScoringRecord — no_show participants', () => {
  it('classifies participant with no group_id as no_show', () => {
    const r = buildScoringRecord('p4', {
      role: 'winemaster',
    }, completedGroups)
    expect(r?.status).toBe('no_show')
  })

  it('classifies participant with unknown group_id as no_show', () => {
    const r = buildScoringRecord('p4', {
      role: 'home_base',
      group_id: 'g-missing',
    }, completedGroups)
    expect(r?.status).toBe('no_show')
  })
})

describe('buildScoringRecord — knowledge_check_score passthrough', () => {
  it('carries knowledge_check_score from Firestore data', () => {
    const r = buildScoringRecord('p5', {
      role: 'winemaster',
      group_id: 'g-deal',
      knowledge_check_score: 0.6,
    }, completedGroups)
    expect(r?.knowledge_check_score).toBe(0.6)
  })

  it('defaults knowledge_check_score to null when absent', () => {
    const r = buildScoringRecord('p5', {
      role: 'winemaster',
      group_id: 'g-deal',
    }, completedGroups)
    expect(r?.knowledge_check_score).toBeNull()
  })

  it('carries null knowledge_check_score as null', () => {
    const r = buildScoringRecord('p5', {
      role: 'winemaster',
      group_id: 'g-deal',
      knowledge_check_score: null,
    }, completedGroups)
    expect(r?.knowledge_check_score).toBeNull()
  })
})
