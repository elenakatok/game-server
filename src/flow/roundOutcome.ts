/**
 * Per-round outcome storage — the Slice 2.5 multi-round backbone (GENERAL, opt-in).
 *
 * OPTION-1 DERIVE (Elena-signed): round 1 is the existing flat `group.outcome`,
 * byte-unchanged; rounds 2+ live in a keyed map `group.outcomes_by_round[roundId]`.
 * An unset key / a one-shot game (no def.rounds) derives to the flat field. Round 1 is
 * NEVER migrated into the map — its outcome stays exactly where every existing game,
 * scorer, and dashboard already reads it.
 *
 * All helpers here are PURE (no firestore import) so they unit-test directly and stay
 * decoupled from the engine git-dep. `setRoundOutcome` returns a Firestore update PATCH
 * (dotted-path for keyed rounds) rather than mutating — the caller spreads it into its
 * own `update()` / `tx.update()`. A keyed patch touches only that round's key, so it can
 * never clobber a sibling round or the round-1 flat field.
 */

/** Field on a group doc holding the rounds-2+ keyed outcome map. */
export const ROUND_OUTCOMES_FIELD = 'outcomes_by_round'

/**
 * Clamp a stored (possibly missing/garbage) round pointer to a valid index.
 * Centralised here so makeAdvanceRound and the submit flows agree on the mapping.
 * Empty round list → 0. Non-integer / absent → 0. Otherwise pinned to [0, len-1].
 */
export function clampRoundIndex(len: number, stored: unknown): number {
  if (len === 0) return 0
  const i = (typeof stored === 'number' && Number.isInteger(stored)) ? stored : 0
  return Math.max(0, Math.min(i, len - 1))
}

/** A resolved storage slot for one round's outcome on a group doc. */
export type RoundSlot =
  /** Round 1 / one-shot game: the existing flat `group.outcome` (unchanged path). */
  | { kind: 'flat' }
  /** Rounds 2+: `group.outcomes_by_round[roundId]`. */
  | { kind: 'keyed'; roundId: string }

/**
 * Resolve which slot a round index maps to (Option-1 derive).
 * No rounds declared, or index 0 → flat. Index ≥ 1 → keyed by rounds[index].
 * `roundIdx` is clamped defensively so a bad pointer can never index out of range.
 */
export function resolveRoundSlot(rounds: readonly string[] | undefined, roundIdx: number): RoundSlot {
  if (!rounds || rounds.length === 0) return { kind: 'flat' }
  const idx = clampRoundIndex(rounds.length, roundIdx)
  if (idx <= 0) return { kind: 'flat' }
  return { kind: 'keyed', roundId: rounds[idx] }
}

/**
 * Read one round's stored outcome from a group doc (Option-1 derive).
 * flat  → group.outcome ?? null (unchanged).
 * keyed → group.outcomes_by_round[roundId] ?? null.
 */
export function getRoundOutcome(
  group: Record<string, unknown>,
  slot: RoundSlot,
): Record<string, unknown> | null {
  if (slot.kind === 'flat') {
    return (group['outcome'] as Record<string, unknown> | null) ?? null
  }
  const map = (group[ROUND_OUTCOMES_FIELD] ?? {}) as Record<string, unknown>
  return (map[slot.roundId] as Record<string, unknown> | null) ?? null
}

/**
 * Build the Firestore update patch that records one round's outcome.
 * flat  → { outcome, agreement_reached } — byte-identical to the existing lock write,
 *         so round-1 / one-shot behaviour is unchanged and existing scorers keep reading
 *         top-level `agreement_reached`.
 * keyed → { 'outcomes_by_round.<roundId>': outcome } — a single dotted-path write that
 *         leaves sibling rounds AND the round-1 flat field untouched. Per-round agreement
 *         derives from null-ness of the stored outcome (no separate field needed).
 */
export function setRoundOutcome(
  slot: RoundSlot,
  outcome: Record<string, unknown> | null,
): Record<string, unknown> {
  if (slot.kind === 'flat') {
    return { outcome, agreement_reached: outcome !== null }
  }
  return { [`${ROUND_OUTCOMES_FIELD}.${slot.roundId}`]: outcome }
}
