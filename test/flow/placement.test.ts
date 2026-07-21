import { describe, it, expect } from 'vitest'
import { mulberry32 } from '@mygames/game-engine'
import { selectPlacementGroup, type PlacementCandidate } from '../../src/flow/placement'

// The selector is generic over the group handle; a string id is enough here.
const c = (id: string, size: number, joinable: boolean): PlacementCandidate<string> => ({
  group: id,
  size,
  joinable,
})

describe('selectPlacementGroup — pure selection (spec §3 steps 1/3/4)', () => {
  it('1. one joinable group → chosen', () => {
    const r = selectPlacementGroup([c('a', 3, true)])
    expect(r).toEqual({ placed: 'a' })
  })

  it('2. several of different sizes → the smallest is chosen', () => {
    const r = selectPlacementGroup([c('a', 4, true), c('b', 2, true), c('c', 3, true)])
    expect(r).toEqual({ placed: 'b' })
  })

  it('3. several tied at the smallest → selection varies across runs (random)', () => {
    // Three joinable groups all at size 2. Over many draws every one must appear
    // (random tiebreak), and only those three ever appear.
    const cands = [c('x', 2, true), c('y', 2, true), c('z', 2, true), c('big', 5, true)]
    const rng = mulberry32(12345)
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const r = selectPlacementGroup(cands, rng)
      if ('placed' in r) seen.add(r.placed)
    }
    expect(seen).toEqual(new Set(['x', 'y', 'z'])) // never 'big', and all three tied appear
  })

  it('3b. deterministic tiebreak endpoints (rng at 0 and ~1)', () => {
    const cands = [c('x', 2, true), c('y', 2, true), c('z', 2, true)]
    expect(selectPlacementGroup(cands, () => 0)).toEqual({ placed: 'x' })       // first tied
    expect(selectPlacementGroup(cands, () => 0.999999)).toEqual({ placed: 'z' }) // last tied (clamped)
  })

  it('4. no joinable groups → absent', () => {
    const r = selectPlacementGroup([c('a', 1, false), c('b', 2, false)])
    expect(r).toEqual({ absent: true })
  })

  it('5. safe default: all candidates non-joinable (as when a game supplies no isJoinable) → absent', () => {
    // placeLatecomer builds every candidate with joinable=false when def.isJoinable
    // is absent, so this is the selector-level shape of the safe default.
    const r = selectPlacementGroup([c('a', 0, false)])
    expect(r).toEqual({ absent: true })
    expect(selectPlacementGroup([])).toEqual({ absent: true }) // no groups at all
  })

  it('6. a non-joinable group is never chosen, even when smaller than every joinable one', () => {
    const r = selectPlacementGroup([
      c('tiny_closed', 0, false), // smallest overall, but NOT joinable
      c('open_a', 4, true),
      c('open_b', 3, true),
    ])
    expect(r).toEqual({ placed: 'open_b' }) // smallest JOINABLE, never 'tiny_closed'
  })
})
