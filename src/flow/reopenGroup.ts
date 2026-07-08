/**
 * Group re-open patch — the single source of truth for "re-open a resolved group so a
 * new round can be negotiated." GENERAL machinery, extracted (Slice 2.7) from
 * makeAdvanceRound so it can be reused by any flow that separates advancing the round
 * pointer from re-opening the groups.
 *
 * Slice 2.5 embedded this write inside makeAdvanceRound (advance + re-open in one batch).
 * Baxter's day-2 flow (Slice 2.7) splits the two steps across two instructor clicks —
 * Button 1 advances the round pointer WITHOUT re-opening (students re-confirm attendance
 * while groups stay closed), Button 2 re-opens after the absence cutoff. Both makeAdvanceRound
 * and Baxter's Button-2 callable now spread THIS patch, so re-open semantics can never drift
 * between the two paths.
 *
 * Re-open resets only the transient per-round WORKING fields; it NEVER touches the stored
 * round outcomes (the round-1 flat `outcome` and the `outcomes_by_round` map both survive):
 *  - status → 'negotiating' so the lead can report the new round (submitLeadOutcome accepts
 *    'negotiating') and the group can reach 'deadlocked'.
 *  - negotiation_started_at re-stamped.
 *  - lead_outcome / lead_reported_at / confirmations / reset_count cleared → re-arm the
 *    confirmation cycle for the new round.
 *  - completed_at / instructor_override deleted → drop the previous round's lock while that
 *    round's outcome stays recorded in its own slot.
 */
import { FieldValue } from 'firebase-admin/firestore'

/**
 * The Firestore update patch that re-opens one group for a new round. Spread into an
 * `update()` / `batch.update()` / `tx.update()` on a group doc. Uses FieldValue sentinels
 * (serverTimestamp / delete), so it must be applied via the admin SDK — it is not a plain
 * data object.
 */
export function reopenGroupPatch(): Record<string, unknown> {
  return {
    status: 'negotiating',
    negotiation_started_at: FieldValue.serverTimestamp(),
    lead_outcome: null,
    lead_reported_at: null,
    confirmations: {},
    reset_count: 0,
    completed_at: FieldValue.delete(),
    instructor_override: FieldValue.delete(),
  }
}
