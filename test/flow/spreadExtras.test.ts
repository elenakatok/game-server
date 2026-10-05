// spreadExtras — extras of a match land in the SMALLEST group, not all in the first.
import { describe, it, expect } from 'vitest'
import { matchParticipants, fieldFor, mulberry32, type MatchGroup } from '@mygames/game-engine'
import { spreadExtras } from '../../src/flow/spreadExtras'
import type { GameDefinition } from '../../src/GameDefinition'

const hawksRoles: GameDefinition['roles'] = {
  roles: [{ key: 'angel', label: 'Angel', short: 'A' }, { key: 'agent', label: 'Agent', short: 'G' }, { key: 'hawks', label: 'Hawks', short: 'H' }],
}
const hawksKeys = ['angel', 'agent', 'hawks']
const hawksComp = { angel: 1, agent: 1, hawks: 2 }
const pairRoles: GameDefinition['roles'] = {
  roles: [{ key: 'chris', label: 'Chris', short: 'C' }, { key: 'kelly', label: 'Kelly', short: 'K' }],
}

const pool = (counts: Record<string, number>) =>
  Object.entries(counts).flatMap(([role, n]) => Array.from({ length: n }, (_, i) => ({ participant_id: `${role}${i + 1}`, role })))
const ids = (g: MatchGroup, keys: string[]) => keys.flatMap(k => g[fieldFor(k, 'participants')] as string[])
const sizes = (gs: MatchGroup[], keys: string[]) => gs.map(g => ids(g, keys).length).sort((a, b) => a - b)

function hawksMatch(counts: Record<string, number>, seed = 7) {
  const eligible = pool(counts)
  const engine = matchParticipants(eligible, { roleConfig: hawksRoles, composition: hawksComp, perRoleCap: eligible.length, rng: mulberry32(seed) })
  return { eligible, engine, spread: spreadExtras(engine, hawksKeys, hawksComp, eligible.length) }
}

describe('spreadExtras', () => {
  it('the Hawks class of 10 (3 Angels, 3 Agents, 4 Hawks): engine gives 6 + 4, spread gives 5 + 5', () => {
    const { engine, spread } = hawksMatch({ angel: 3, agent: 3, hawks: 4 })
    expect(sizes(engine, hawksKeys)).toEqual([4, 6])     // the behaviour being fixed
    expect(sizes(spread, hawksKeys)).toEqual([5, 5])
  })

  it('Hawks class of 11 (3, 3, 5): 7 + 4 becomes 6 + 5', () => {
    const { engine, spread } = hawksMatch({ angel: 3, agent: 3, hawks: 5 })
    expect(sizes(engine, hawksKeys)).toEqual([4, 7])
    expect(sizes(spread, hawksKeys)).toEqual([5, 6])
  })

  it.each([
    [{ angel: 2, agent: 2, hawks: 4 }], [{ angel: 3, agent: 2, hawks: 4 }], [{ angel: 3, agent: 3, hawks: 4 }],
    [{ angel: 3, agent: 3, hawks: 5 }], [{ angel: 3, agent: 3, hawks: 6 }], [{ angel: 5, agent: 4, hawks: 9 }],
    [{ angel: 7, agent: 3, hawks: 6 }], [{ angel: 4, agent: 4, hawks: 13 }],
  ])('%o: nobody lost or duplicated, complete groups intact, leads unchanged, sizes within 1 where possible', (counts) => {
    for (const seed of [1, 7, 42]) {
      const { eligible, engine, spread } = hawksMatch(counts, seed)
      expect(spread.length).toBe(engine.length)
      // same people, each exactly once
      expect(spread.flatMap(g => ids(g, hawksKeys)).sort()).toEqual(eligible.map(p => p.participant_id).sort())
      spread.forEach((g, i) => {
        expect(g.lead_participant_id).toBe(engine[i].lead_participant_id)
        for (const k of hawksKeys) {
          const now = g[fieldFor(k, 'participants')] as string[]
          const was = engine[i][fieldFor(k, 'participants')] as string[]
          expect(now.length).toBeGreaterThanOrEqual(hawksComp[k as keyof typeof hawksComp]) // still a complete group
          expect(now.slice(0, hawksComp[k as keyof typeof hawksComp])).toEqual(was.slice(0, hawksComp[k as keyof typeof hawksComp])) // base members untouched
        }
        expect(ids(g, hawksKeys)).toContain(g.lead_participant_id)
      })
      const s = sizes(spread, hawksKeys)
      expect(s[s.length - 1] - s[0]).toBeLessThanOrEqual(1)
      // never worse than the engine
      const e = sizes(engine, hawksKeys)
      expect(s[s.length - 1] - s[0]).toBeLessThanOrEqual(e[e.length - 1] - e[0])
    }
  })

  it('no extras → the very same groups come back', () => {
    const { engine, spread } = hawksMatch({ angel: 2, agent: 2, hawks: 4 })
    expect(spread).toBe(engine)
  })

  it('a single group keeps all its extras (nowhere else to put them)', () => {
    const { engine, spread } = hawksMatch({ angel: 2, agent: 1, hawks: 3 })
    expect(engine.length).toBe(1)
    expect(spread).toBe(engine)
  })

  it('1 + 1 game, 7 Chris + 4 Kelly: three extra Chris go to three different groups', () => {
    const eligible = pool({ chris: 7, kelly: 4 })
    const engine = matchParticipants(eligible, { roleConfig: pairRoles, composition: { chris: 1, kelly: 1 }, perRoleCap: eligible.length, rng: mulberry32(3) })
    const spread = spreadExtras(engine, ['chris', 'kelly'], { chris: 1, kelly: 1 }, eligible.length)
    expect(sizes(spread, ['chris', 'kelly'])).toEqual([2, 3, 3, 3])
  })

  it('perRoleCap is honoured: a group at the cap for a role takes no more of it', () => {
    const eligible = pool({ chris: 6, kelly: 2 })
    const cap = 2
    const engine = matchParticipants(eligible, { roleConfig: pairRoles, composition: { chris: 1, kelly: 1 }, perRoleCap: cap, rng: mulberry32(5) })
    const spread = spreadExtras(engine, ['chris', 'kelly'], { chris: 1, kelly: 1 }, cap)
    for (const g of spread) expect((g.chris_participants as string[]).length).toBeLessThanOrEqual(cap)
    // the engine could place 2 of the 4 extra Chris under this cap; so can the spread — no more, no fewer
    const placed = (gs: MatchGroup[]) => gs.reduce((n, g) => n + (g.chris_participants as string[]).length, 0)
    expect(placed(spread)).toBe(placed(engine))
  })

  it('does not mutate the engine result', () => {
    const { engine } = hawksMatch({ angel: 3, agent: 3, hawks: 4 })
    const before = JSON.stringify(engine)
    spreadExtras(engine, hawksKeys, hawksComp, 10)
    expect(JSON.stringify(engine)).toBe(before)
  })

  // ── remnant-group games (Adirondacks: 2 per role, remnant 1 per role) ──────────
  const adkKeys = ['gpp', 'ala', 'flp', 'fcc', 'governor', 'atb']
  const adkRoles: GameDefinition['roles'] = { roles: adkKeys.map(k => ({ key: k, label: k, short: k[0] })) }
  const adkComp = Object.fromEntries(adkKeys.map(k => [k, 2]))
  const adkRemnant = { composition: Object.fromEntries(adkKeys.map(k => [k, 1])) }
  const adkMatch = (counts: Record<string, number>) => {
    const eligible = pool(counts)
    const engine = matchParticipants(eligible, { roleConfig: adkRoles, composition: adkComp, perRoleCap: eligible.length, remnantGroup: adkRemnant, rng: mulberry32(11) })
    return { engine, spread: spreadExtras(engine, adkKeys, adkComp, eligible.length) }
  }

  it('a remnant group FORMED → the engine placement is returned untouched', () => {
    // 5 of every role = two groups of 12 + one remnant group of 6; one more gpp and ala as extras
    const { engine, spread } = adkMatch({ gpp: 6, ala: 6, flp: 5, fcc: 5, governor: 5, atb: 5 })
    expect(engine.length).toBe(3)
    expect(spread).toBe(engine)
  })

  it('remnant-capable game but NO remnant group formed → extras are spread (13 + 13, not 14 + 12)', () => {
    const { engine, spread } = adkMatch({ gpp: 5, ala: 5, flp: 4, fcc: 4, governor: 4, atb: 4 })
    expect(sizes(engine, adkKeys)).toEqual([12, 14])
    expect(sizes(spread, adkKeys)).toEqual([13, 13])
  })
})
