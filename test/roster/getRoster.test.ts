import { describe, it, expect } from 'vitest'
import { mapParticipant, mapGroup } from '../../src/roster/makeGetRoster'
import type { RoleConfig } from '@mygames/game-engine'

const twoRoleConfig: RoleConfig = {
  roles: [
    { key: 'winemaster', label: 'Winemaster', short: 'W' },
    { key: 'home_base',  label: 'Home Base',  short: 'H' },
  ],
}

describe('mapParticipant — role labels', () => {
  it('returns correct role_label for a declared role', () => {
    const r = mapParticipant('uid-1', { role: 'winemaster' }, null, twoRoleConfig)
    expect(r.role_label).toBe('Winemaster')
  })

  it('returns correct role_label for the second declared role', () => {
    const r = mapParticipant('uid-1', { role: 'home_base' }, null, twoRoleConfig)
    expect(r.role_label).toBe('Home Base')
  })

  it('returns null role_label for an undeclared role key', () => {
    const r = mapParticipant('uid-1', { role: 'chris' }, null, twoRoleConfig)
    expect(r.role_label).toBeNull()
  })

  it('returns null role_label when role field is absent', () => {
    const r = mapParticipant('uid-1', {}, null, twoRoleConfig)
    expect(r.role).toBeNull()
    expect(r.role_label).toBeNull()
  })
})

describe('mapParticipant — display_name fallback chain', () => {
  it('prefers RTDB attending display_name over everything', () => {
    const r = mapParticipant(
      'uid-1',
      { display_name: 'Firestore Name', name: 'Enrollment Name' },
      { display_name: 'RTDB Name' },
      twoRoleConfig,
    )
    expect(r.display_name).toBe('RTDB Name')
  })

  it('falls back to Firestore display_name when RTDB entry is absent', () => {
    const r = mapParticipant(
      'uid-1',
      { display_name: 'Firestore Display', name: 'Enrollment Name' },
      null,
      twoRoleConfig,
    )
    expect(r.display_name).toBe('Firestore Display')
  })

  it('falls back to Firestore name when display_name is absent', () => {
    const r = mapParticipant('uid-1', { name: 'Enrollment Name' }, null, twoRoleConfig)
    expect(r.display_name).toBe('Enrollment Name')
  })

  it('falls back to id prefix when no name fields available', () => {
    const r = mapParticipant('abcdefghijklm', {}, null, twoRoleConfig)
    expect(r.display_name).toBe('abcdefgh…')
  })

  it('falls back to id prefix when RTDB display_name is empty string', () => {
    const r = mapParticipant('abcdefghijklm', {}, { display_name: '' }, twoRoleConfig)
    expect(r.display_name).toBe('abcdefgh…')
  })
})

describe('mapParticipant — boolean flags', () => {
  it('maps all flags true when timestamps and flags are set', () => {
    const r = mapParticipant(
      'uid-1',
      {
        attendance_confirmed_at: new Date(),
        finalized_at: new Date(),
        prep_completed_at: new Date(),
        participant_late: true,
      },
      null,
      twoRoleConfig,
    )
    expect(r.attended).toBe(true)
    expect(r.finalized).toBe(true)
    expect(r.has_prep_completed).toBe(true)
    expect(r.is_late).toBe(true)
  })

  it('returns all flags false for a fresh participant doc', () => {
    const r = mapParticipant('uid-1', {}, null, twoRoleConfig)
    expect(r.attended).toBe(false)
    expect(r.finalized).toBe(false)
    expect(r.has_prep_completed).toBe(false)
    expect(r.is_late).toBe(false)
  })

  it('is_late is false when participant_late is absent', () => {
    const r = mapParticipant('uid-1', { participant_late: false }, null, twoRoleConfig)
    expect(r.is_late).toBe(false)
  })
})

describe('mapGroup', () => {
  it('maps participants_by_role using fieldFor(key, "participants") convention', () => {
    const data = {
      group_id: 'g-1',
      status: 'completed',
      lead_participant_id: 'uid-1',
      winemaster_participants: ['uid-1'],
      home_base_participants: ['uid-2'],
      agreement_reached: true,
      outcome: { shares: 100000, vesting: 'Immediate' },
    }
    const r = mapGroup('g-1', data, twoRoleConfig)
    expect(r.participants_by_role).toEqual({
      winemaster: ['uid-1'],
      home_base: ['uid-2'],
    })
    expect(r.lead_participant_id).toBe('uid-1')
    expect(r.agreement_reached).toBe(true)
    expect(r.outcome).toEqual({ shares: 100000, vesting: 'Immediate' })
  })

  it('falls back to doc id when group_id field is absent', () => {
    const r = mapGroup('doc-id-fallback', { status: 'pending' }, twoRoleConfig)
    expect(r.group_id).toBe('doc-id-fallback')
  })

  it('returns empty arrays for participants_by_role when role fields absent', () => {
    const r = mapGroup('g-2', { group_id: 'g-2', status: 'pending' }, twoRoleConfig)
    expect(r.participants_by_role).toEqual({
      winemaster: [],
      home_base: [],
    })
  })

  it('returns null for agreement_reached and outcome when not set', () => {
    const r = mapGroup('g-3', { group_id: 'g-3', status: 'negotiating' }, twoRoleConfig)
    expect(r.agreement_reached).toBeNull()
    expect(r.outcome).toBeNull()
    expect(r.lead_participant_id).toBeNull()
  })
})
