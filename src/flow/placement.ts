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
