// Latecomer placement — pure selection logic (Latecomer_Placement_Spec_v1 §3,
// steps 1/3/4). NO I/O: this is the whole "which group?" decision in isolation,
// so it can be unit-tested directly. The Firestore transaction that reads groups
// and writes the placement wraps this (see placeLatecomer.ts).
//
// Rule: among the joinable groups, pick the one with the fewest participants;
// break ties RANDOMLY; if none is joinable, the latecomer is absent.

/** One group offered to the selector, reduced to just what the decision needs. */
export interface PlacementCandidate<G> {
  /** The caller's opaque group handle, returned verbatim when this one is picked. */
  group: G
  /** Total participants already in the group (across every role). */
  size: number
  /** Result of the game's isJoinable predicate for this group. */
  joinable: boolean
}

/** Either the chosen group, or absent when nothing is joinable. */
export type PlacementResult<G> = { placed: G } | { absent: true }

/**
 * Select the group a latecomer should join.
 *
 * 1. Keep only joinable candidates.
 * 2. None joinable → { absent: true }.
 * 3. Otherwise take the smallest by `size`.
 * 4. On a tie, choose uniformly at random among the tied groups (`rng` injected
 *    for deterministic tests; defaults to Math.random).
 *
 * A non-joinable group is never chosen, however small — even smaller than every
 * joinable one (spec §3 step 1 filters before step 3).
 */
export function selectPlacementGroup<G>(
  candidates: PlacementCandidate<G>[],
  rng: () => number = Math.random,
): PlacementResult<G> {
  const joinable = candidates.filter((c) => c.joinable)
  if (joinable.length === 0) return { absent: true }

  let min = Infinity
  for (const c of joinable) if (c.size < min) min = c.size
  const tied = joinable.filter((c) => c.size === min)

  if (tied.length === 1) return { placed: tied[0].group }
  // rng() is in [0, 1); clamp defensively in case an injected rng yields 1.
  const idx = Math.min(Math.floor(rng() * tied.length), tied.length - 1)
  return { placed: tied[idx].group }
}

// ── Spare split (opt-in: GameDefinition.latecomerPairsWithSpare) ────────────────
//
// Pure: given the joinable groups' role arrays, can the latecomer plus SPARES
// (members beyond the base composition) form one complete new group?

/** A joinable group, reduced to what the spare selector needs. */
export interface SpareSource {
  groupId: string
  leadId: string | null
  /** role key → participant ids, in stored order (extras are appended last). */
  membersByRole: Record<string, string[]>
}

/** A member to pull out of an existing group into the new one. */
export interface SparePick { groupId: string; participantId: string; role: string }

/**
 * Pick the spares that, with a latecomer of `latecomerRole`, make one complete
 * base-composition group. Returns null when that is not possible — the caller then
 * places the latecomer the ordinary way.
 *
 * A group gives up only its SURPLUS over the base composition for that role, so no
 * source group is ever left short; its lead is never taken; and spares are taken
 * from the END of the role array (where matching appended its extras), from the
 * groups with the largest surplus first.
 */
export function selectSpareSplit(
  sources: SpareSource[],
  roleKeyList: string[],
  composition: Record<string, number>,
  latecomerRole: string,
): SparePick[] | null {
  if (!roleKeyList.includes(latecomerRole)) return null
  const picks: SparePick[] = []
  for (const role of roleKeyList) {
    const base = composition[role] ?? 1
    let need = base - (role === latecomerRole ? 1 : 0)
    if (need <= 0) continue
    const offers = sources
      .map(g => {
        const ids = (g.membersByRole[role] ?? []).filter(id => id !== g.leadId)
        const surplus = Math.min((g.membersByRole[role] ?? []).length - base, ids.length)
        return { g, spare: surplus > 0 ? ids.slice(ids.length - surplus) : [] }
      })
      .filter(o => o.spare.length > 0)
      .sort((a, b) => b.spare.length - a.spare.length)
    for (const o of offers) {
      while (need > 0 && o.spare.length > 0) {
        picks.push({ groupId: o.g.groupId, participantId: o.spare.pop()!, role })
        need--
      }
      if (need === 0) break
    }
    if (need > 0) return null
  }
  return picks.length > 0 ? picks : null
}
