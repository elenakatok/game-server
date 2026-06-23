import { describe, it, expect } from 'vitest'
import { pickRole } from '../../src/join/makeAssignRole'

describe('pickRole — 2-role balance', () => {
  it('picks first declared role on tie (empty counts)', () => {
    expect(pickRole(['winemaster', 'home_base'], {})).toBe('winemaster')
  })

  it('picks role with fewer assignments', () => {
    expect(pickRole(['winemaster', 'home_base'], { winemaster: 2, home_base: 1 })).toBe('home_base')
    expect(pickRole(['winemaster', 'home_base'], { winemaster: 0, home_base: 1 })).toBe('winemaster')
  })

  it('handles a missing count key as zero', () => {
    expect(pickRole(['winemaster', 'home_base'], { winemaster: 3 })).toBe('home_base')
  })

  it('alternates correctly across 4 sequential joins', () => {
    const keys = ['winemaster', 'home_base']
    const counts: Record<string, number> = {}
    const results: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = pickRole(keys, counts)
      results.push(r)
      counts[r] = (counts[r] ?? 0) + 1
    }
    expect(results).toEqual(['winemaster', 'home_base', 'winemaster', 'home_base'])
  })
})

describe('pickRole — 3-role balance (N-role generality)', () => {
  it('picks the minimum among 3 roles', () => {
    expect(pickRole(['a', 'b', 'c'], { a: 3, b: 1, c: 2 })).toBe('b')
    expect(pickRole(['a', 'b', 'c'], { a: 1, b: 2, c: 0 })).toBe('c')
  })

  it('picks first declared role on full tie', () => {
    expect(pickRole(['a', 'b', 'c'], { a: 2, b: 2, c: 2 })).toBe('a')
  })

  it('picks first declared minimum on partial tie', () => {
    // a=0, b=0, c=1 → tie between a and b → first declared (a) wins
    expect(pickRole(['a', 'b', 'c'], { a: 0, b: 0, c: 1 })).toBe('a')
  })

  it('cycles correctly across 6 sequential joins', () => {
    const keys = ['a', 'b', 'c']
    const counts: Record<string, number> = {}
    const results: string[] = []
    for (let i = 0; i < 6; i++) {
      const r = pickRole(keys, counts)
      results.push(r)
      counts[r] = (counts[r] ?? 0) + 1
    }
    expect(results).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
  })
})
