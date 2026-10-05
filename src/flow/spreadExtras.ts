// Spreading the EXTRAS of a match evenly across groups.
//
// matchParticipants (game-engine) fills every complete group first, then hands out the
// leftovers role by role — and restarts at the FIRST group for each role. With more
// than one role holding a leftover, they pile up: a Hawks class of 10 (3 Angels,
// 3 Agents, 4 Hawks) matched as one group of SIX and one of four, both extras in the
// same group. Noticed 2026-10-05.
//
// This is a pure post-pass over the engine's result: lift every member beyond the base
// composition back out, then give each one to the group that is currently SMALLEST.
// Complete groups are still formed first and are never broken up; only where the
// extras land changes. It lives here rather than in the engine so that a game gets it
// by moving one pin (game-server), not two.

import { fieldFor, type MatchGroup } from '@mygames/game-engine'

/**
 * Re-distribute the extras of `groups` so group sizes differ by as little as possible.
 *
 * - A group keeps its first `composition[role]` members of each role (which includes
 *   its lead — the engine puts the lead first); everything after that is an extra.
 * - Each extra goes to the group with the smallest TOTAL size; ties go to the group
 *   with the fewest of that role, then to the earliest group (the engine has already
 *   shuffled, so "earliest" is not a fixed student).
 * - If any group is below the base composition (a remnant group formed), nothing is
 *   moved — see below.
 * - `perRoleCap` is honoured exactly as the engine honours it: a group already holding
 *   `perRoleCap` of a role takes no more of it. An extra no group can take is left out,
 *   as before.
 *
 * Returns new group objects; the input is not mutated.
 */
export function spreadExtras(
  groups: MatchGroup[],
  roleKeyList: string[],
  composition: Record<string, number>,
  perRoleCap: number,
): MatchGroup[] {
  if (groups.length < 2) return groups

  // A group BELOW the base composition is a remnant group (Adirondacks: a deliberate
  // one-per-role group beside the two-per-role ones). "Smallest first" would pour every
  // extra into it, so when one has formed the engine's placement is left exactly as is.
  const belowBase = (g: MatchGroup) =>
    roleKeyList.some(k => ((g[fieldFor(k, 'participants')] as string[] | undefined) ?? []).length < (composition[k] ?? 1))
  if (groups.some(belowBase)) return groups

  const out = groups.map(g => {
    const copy: MatchGroup = { ...g }
    for (const k of roleKeyList) copy[fieldFor(k, 'participants')] = [...((g[fieldFor(k, 'participants')] as string[] | undefined) ?? [])]
    return copy
  })
  const members = (g: MatchGroup, k: string) => g[fieldFor(k, 'participants')] as string[]
  const sizeOf = (g: MatchGroup) => roleKeyList.reduce((n, k) => n + members(g, k).length, 0)

  // Lift the extras out, role by role in declared order (the order the engine placed them).
  const extras: { id: string; role: string }[] = []
  for (const k of roleKeyList) {
    const base = composition[k] ?? 1
    for (const g of out) {
      const arr = members(g, k)
      if (arr.length > base) for (const id of arr.splice(base)) extras.push({ id, role: k })
    }
  }
  if (extras.length === 0) return groups

  for (const e of extras) {
    let best: MatchGroup | null = null
    for (const g of out) {
      if (members(g, e.role).length >= perRoleCap) continue
      if (
        best === null ||
        sizeOf(g) < sizeOf(best) ||
        (sizeOf(g) === sizeOf(best) && members(g, e.role).length < members(best, e.role).length)
      ) best = g
    }
    if (best) members(best, e.role).push(e.id)
  }
  return out
}
