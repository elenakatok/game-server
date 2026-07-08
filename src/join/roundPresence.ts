/**
 * Per-round attendance presence storage — the Slice 2.6 round-aware attendance
 * backbone (GENERAL, opt-in). Mirrors the Slice 2.5 outcome pattern in
 * ../flow/roundOutcome.ts and shares its slot resolution.
 *
 * OPTION-1 DERIVE (Elena-signed): round 1 is the existing flat participant field
 * `attendance_confirmed_at`, byte-unchanged; rounds 2+ live in a keyed map
 * `attendance_by_round[roundId]`. An unset key, a one-shot game (no def.rounds),
 * and current_round 0 all derive to the flat field. Round 1 is NEVER migrated into
 * the map — its presence flag stays exactly where getRoster's `attended`, matching
 * eligibility, and the student routing guard already read it.
 *
 * Slot resolution (flat vs keyed) is shared with roundOutcome via `resolveRoundSlot`,
 * so attendance and outcome agree on the round-index → slot mapping. All helpers here
 * are PURE (no firestore import) so they unit-test directly. `setRoundPresence`
 * returns a Firestore update PATCH (a dotted-path for keyed rounds) rather than
 * mutating — the caller spreads it into its own `update()`. A keyed patch touches
 * only that round's key, so it can never clobber a sibling round or the round-1 flat
 * field.
 */
import { resolveRoundSlot, type RoundSlot } from '../flow/roundOutcome'

/** Field on a participant doc holding the rounds-2+ keyed presence map. */
export const ATTENDANCE_BY_ROUND_FIELD = 'attendance_by_round'

/**
 * Is presence recorded at a resolved slot?
 * flat  → participant.attendance_confirmed_at != null (unchanged read).
 * keyed → participant.attendance_by_round[roundId] != null.
 */
export function presenceAtSlot(
  participant: Record<string, unknown>,
  slot: RoundSlot,
): boolean {
  if (slot.kind === 'flat') {
    return participant['attendance_confirmed_at'] != null
  }
  const map = (participant[ATTENDANCE_BY_ROUND_FIELD] ?? {}) as Record<string, unknown>
  return map[slot.roundId] != null
}

/**
 * Build the Firestore update patch that records presence for one round.
 * flat  → { attendance_confirmed_at: value } — byte-identical to the existing verify
 *         write, so round-1 / one-shot behaviour is unchanged and existing readers
 *         (getRoster `attended`, matching eligibility, student guard) keep working.
 * keyed → { 'attendance_by_round.<roundId>': value } — a single dotted-path write that
 *         leaves sibling rounds AND the round-1 flat field untouched.
 */
export function setRoundPresence(
  slot: RoundSlot,
  value: unknown,
): Record<string, unknown> {
  if (slot.kind === 'flat') {
    return { attendance_confirmed_at: value }
  }
  return { [`${ATTENDANCE_BY_ROUND_FIELD}.${slot.roundId}`]: value }
}

/**
 * Public read helper for the future scorer / dashboard: is a participant present for
 * a given round? Resolves the Option-1 slot from the game's round list + the class
 * round index, then reads presence there.
 * round 1 / unset / one-shot → the flat flag; rounds 2+ → the keyed slot.
 * A student present day 1 but absent day 2 reads present at round 1, absent at round 2.
 */
export function getRoundPresence(
  participant: Record<string, unknown>,
  rounds: readonly string[] | undefined,
  roundIdx: number,
): boolean {
  return presenceAtSlot(participant, resolveRoundSlot(rounds, roundIdx))
}
