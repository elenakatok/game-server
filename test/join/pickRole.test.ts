import { describe, it, expect } from 'vitest'
import { pickRole } from '../../src/join/makeAssignRole'

// ── Symmetric games — no composition arg (defaults to all-1s) ────────────────

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

// ── Asymmetric composition ────────────────────────────────────────────────────

describe('pickRole — asymmetric composition', () => {
  it('symmetric 1:1 explicit composition is byte-for-byte identical to no composition', () => {
    const keys = ['winemaster', 'home_base']
    const countsA: Record<string, number> = {}
    const countsB: Record<string, number> = {}
    const resultsA: string[] = []
    const resultsB: string[] = []
    for (let i = 0; i < 6; i++) {
      const rA = pickRole(keys, countsA, { winemaster: 1, home_base: 1 })
      const rB = pickRole(keys, countsB)
      resultsA.push(rA); countsA[rA] = (countsA[rA] ?? 0) + 1
      resultsB.push(rB); countsB[rB] = (countsB[rB] ?? 0) + 1
    }
    expect(resultsA).toEqual(resultsB)
  })

  it('picks first on tie when fill-fractions are equal (both at composition target)', () => {
    // a has 2 (composition 2), b has 1 (composition 1) → both fill-fraction 1.0 → first wins
    expect(pickRole(['a', 'b'], { a: 2, b: 1 }, { a: 2, b: 1 })).toBe('a')
  })

  it('fills role_a twice as fast as role_b for 2:1 composition across 12 joins', () => {
    const keys = ['a', 'b']
    const composition = { a: 2, b: 1 }
    const counts: Record<string, number> = {}
    for (let i = 0; i < 12; i++) {
      const r = pickRole(keys, counts, composition)
      counts[r] = (counts[r] ?? 0) + 1
    }
    // 2:1 ratio → 8 a and 4 b
    expect(counts['a']).toBe(8)
    expect(counts['b']).toBe(4)
  })

  it('fills Hawkes 2:1:1 (hawkes:supplier:retailer) correctly across 8 joins', () => {
    const keys = ['hawkes', 'supplier', 'retailer']
    const composition = { hawkes: 2, supplier: 1, retailer: 1 }
    const counts: Record<string, number> = {}
    for (let i = 0; i < 8; i++) {
      const r = pickRole(keys, counts, composition)
      counts[r] = (counts[r] ?? 0) + 1
    }
    // 2:1:1 ratio across 8 joins → 4 hawkes, 2 supplier, 2 retailer
    expect(counts['hawkes']).toBe(4)
    expect(counts['supplier']).toBe(2)
    expect(counts['retailer']).toBe(2)
  })

  it('under-filled high-composition role is always preferred over over-filled low-composition role', () => {
    // a needs 3, b needs 1. If b already has 1 and a has 0: a fill-frac=0, b fill-frac=1 → pick a
    expect(pickRole(['a', 'b'], { a: 0, b: 1 }, { a: 3, b: 1 })).toBe('a')
    // a has 1 (fill 1/3≈0.33), b has 0 (fill 0/1=0) → pick b
    expect(pickRole(['a', 'b'], { a: 1, b: 0 }, { a: 3, b: 1 })).toBe('b')
  })
})
