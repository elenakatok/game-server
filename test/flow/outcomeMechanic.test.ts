import { describe, it, expect } from 'vitest'
import { resolveOutcomeMechanic } from '../../src/flow/makeSubmitConfirmation'
import type { GameDefinition } from '../../src/GameDefinition'

// Minimal defs — resolveOutcomeMechanic only reads rounds / outcomeMechanic / roundOutcomeMechanics.
const def = (partial: Partial<GameDefinition>): GameDefinition => partial as unknown as GameDefinition

describe('resolveOutcomeMechanic', () => {
  it('absent config → unanimous (byte-identical default for every existing game)', () => {
    expect(resolveOutcomeMechanic(def({}), 0)).toBe('unanimous')
    expect(resolveOutcomeMechanic(def({ rounds: ['a', 'b'] }), 1)).toBe('unanimous')
  })

  it('whole-game outcomeMechanic applies to every round', () => {
    const d = def({ outcomeMechanic: 'ultimatum' })
    expect(resolveOutcomeMechanic(d, 0)).toBe('ultimatum')
    const dr = def({ rounds: ['a', 'b', 'c'], outcomeMechanic: 'ultimatum' })
    expect(resolveOutcomeMechanic(dr, 2)).toBe('ultimatum')
  })

  it('per-round override wins over the whole-game default', () => {
    const d = def({
      rounds: ['1978', '1983', '1985'],
      roundOutcomeMechanics: { '1978': 'ultimatum', '1985': 'ultimatum' },
    })
    expect(resolveOutcomeMechanic(d, 0)).toBe('ultimatum') // 1978
    expect(resolveOutcomeMechanic(d, 1)).toBe('unanimous') // 1983 — no override, no game default
    expect(resolveOutcomeMechanic(d, 2)).toBe('ultimatum') // 1985
  })

  it('a round absent from the map falls back to the game default', () => {
    const d = def({
      rounds: ['1978', '1983', '1985'],
      outcomeMechanic: 'ultimatum',
      roundOutcomeMechanics: { '1983': 'unanimous' },
    })
    expect(resolveOutcomeMechanic(d, 0)).toBe('ultimatum') // falls back to game default
    expect(resolveOutcomeMechanic(d, 1)).toBe('unanimous') // explicit override
    expect(resolveOutcomeMechanic(d, 2)).toBe('ultimatum') // falls back to game default
  })

  it('clamps a garbage / out-of-range round pointer defensively', () => {
    const d = def({ rounds: ['1978', '1983'], roundOutcomeMechanics: { '1978': 'ultimatum' } })
    expect(resolveOutcomeMechanic(d, -5)).toBe('ultimatum') // clamps to 0 → 1978
    expect(resolveOutcomeMechanic(d, 99)).toBe('unanimous') // clamps to last → 1983 (no override)
  })
})
