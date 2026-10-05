// selectSpareSplit — pure spare selection for GameDefinition.latecomerPairsWithSpare.
import { describe, it, expect } from 'vitest'
import { selectSpareSplit, type SpareSource } from '../../src/flow/placement'

const keys = ['chris', 'kelly']
const pair = { chris: 1, kelly: 1 }
const g = (groupId: string, chris: string[], kelly: string[], leadId = chris[0] ?? null): SpareSource =>
  ({ groupId, leadId, membersByRole: { chris, kelly } })

describe('selectSpareSplit', () => {
  it('latecomer Kelly + the extra Chris of a 2C+1K group → that Chris is picked', () => {
    const picks = selectSpareSplit([g('g1', ['c1'], ['k1']), g('g2', ['c2', 'c3'], ['k2'])], keys, pair, 'kelly')
    expect(picks).toEqual([{ groupId: 'g2', participantId: 'c3', role: 'chris' }])
  })

  it('never takes the lead, even when the lead is the last in the array', () => {
    const picks = selectSpareSplit([g('g2', ['c2', 'c3'], ['k2'], 'c3')], keys, pair, 'kelly')
    expect(picks).toEqual([{ groupId: 'g2', participantId: 'c2', role: 'chris' }])
  })

  it('no spare of the opposite role → null (ordinary placement takes over)', () => {
    expect(selectSpareSplit([g('g1', ['c1'], ['k1'])], keys, pair, 'kelly')).toBeNull()
    // the only spare is the SAME role as the latecomer → still no pair
    expect(selectSpareSplit([g('g2', ['c2'], ['k2', 'k3'])], keys, pair, 'kelly')).toBeNull()
  })

  it('never leaves a source group short: a 1C+0K half-group has no spare Chris', () => {
    expect(selectSpareSplit([g('g1', ['c1'], [])], keys, pair, 'kelly')).toBeNull()
  })

  it('2+2 composition: needs 2 of the other role and 1 of its own, across groups', () => {
    const comp = { chris: 2, kelly: 2 }
    const sources = [g('g1', ['a', 'b', 'c'], ['k1', 'k2']), g('g2', ['d', 'e', 'f'], ['k3', 'k4', 'k5'])]
    const picks = selectSpareSplit(sources, keys, comp, 'kelly')!
    expect(picks.filter(p => p.role === 'chris').map(p => p.participantId).sort()).toEqual(['c', 'f'])
    expect(picks.filter(p => p.role === 'kelly').map(p => p.participantId)).toEqual(['k5'])
    // one spare Chris short → null
    expect(selectSpareSplit([sources[0]], keys, comp, 'kelly')).toBeNull()
  })

  it('unknown latecomer role → null', () => {
    expect(selectSpareSplit([g('g2', ['c2', 'c3'], ['k2'])], keys, pair, 'observer')).toBeNull()
  })
})
