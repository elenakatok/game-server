import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import { resolveRoundSlot } from '../flow/roundOutcome'
import { presenceAtSlot, setRoundPresence } from './roundPresence'
import { placeLatecomer } from '../flow/placeLatecomer'
import type { GameDefinition } from '../GameDefinition'

async function doVerifyAttendanceCode(
  def: GameDefinition,
  gameInstanceId: string,
  participantId: string,
  submittedCode: string,
): Promise<void> {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const participantRef = instanceRef.collection('participants').doc(participantId)
  const codeRef = instanceRef.collection('attendance_code').doc('current')

  // Round-aware, opt-in (Slice 2.6). A staged game (def.rounds declared) resolves the
  // CURRENT round from the instance's current_round pointer; a one-shot game skips the
  // instance read entirely and derives to the flat round-1 slot — so its write,
  // idempotency, and RTDB overlay stay byte-identical to pre-Slice-2.6 behaviour.
  const isStaged = Array.isArray(def.rounds) && def.rounds.length > 0

  const [participantSnap, codeSnap, instanceSnap] = await Promise.all([
    participantRef.get(),
    codeRef.get(),
    isStaged ? instanceRef.get() : Promise.resolve(null),
  ])

  if (!participantSnap.exists) throw new HttpsError('not-found', 'Participant not found.')

  const pdata = participantSnap.data()!

  if (pdata.confirmed_ready_at == null) {
    throw new HttpsError('failed-precondition', 'Please complete the confirmation step first.')
  }

  // resolveRoundSlot clamps a missing/garbage pointer to round 1 (flat). One-shot /
  // current_round 0 → { kind: 'flat' } → the existing attendance_confirmed_at path.
  const slot = resolveRoundSlot(def.rounds, instanceSnap?.data()?.['current_round'])

  // Idempotent PER ROUND: already confirmed for THIS round → no-op. A round-1
  // confirmation no longer short-circuits a rounds-2+ confirmation (the Slice 2.6 fix);
  // for one-shot / round 1 this is the same flat guard as before.
  if (presenceAtSlot(pdata, slot)) return

  if (!codeSnap.exists) {
    throw new HttpsError(
      'failed-precondition',
      'No attendance code has been generated yet. Ask your instructor to display one.',
    )
  }

  // The instructor regenerates the code per round (a new code overwrites
  // attendance_code/current), so matching against the current code is correct. The
  // code doc carries no round tag today — see the note in makeVerifyAttendanceCode.
  const storedCode = (codeSnap.data()!.code as string).toUpperCase()
  if (submittedCode.toUpperCase().trim() !== storedCode) {
    throw new HttpsError(
      'invalid-argument',
      "That code doesn't match. Check what your instructor is displaying and try again.",
    )
  }

  // Round-scoped presence write. Round 1 / one-shot → the existing flat
  // attendance_confirmed_at (unchanged path); rounds 2+ → the keyed slot, leaving the
  // round-1 flat flag and sibling rounds intact.
  await participantRef.update(setRoundPresence(slot, FieldValue.serverTimestamp()))

  // Mirror to the RTDB attending overlay so the instructor dashboard shows a real-time
  // attendance list. This path is persistent (never deleted on disconnect). Round 1 /
  // one-shot writes the existing per-instance path (byte-unchanged); rounds 2+ write a
  // per-round subtree so the future day-2 dashboard can read who was present each round.
  const overlay = {
    display_name: (pdata.display_name as string | undefined) ?? (pdata.name as string | undefined) ?? '',
    role: pdata.role ?? '',
    confirmed_at: Date.now(),
  }
  const overlayRef = slot.kind === 'flat'
    ? admin.database().ref(`attending/${gameInstanceId}/${participantId}`)
    : admin.database().ref(`attending_by_round/${gameInstanceId}/${slot.roundId}/${participantId}`)
  await overlayRef.set(overlay)

  // ── Latecomer auto-placement (Latecomer_Placement_Spec_v1 §3) ──────────────
  // OPT-IN and ADDITIVE: a game that declares no isJoinable skips this entire
  // block, so its behaviour is byte-identical to before. It runs only AFTER
  // matching has produced groups; a student who confirms BEFORE matching just
  // waits as today (no groups → skip). `pdata` predates the presence write, so
  // its null group_id correctly identifies an unplaced student on first entry.
  //
  // FIRST-ROUND GATE (multi-round games): placement runs only in the FIRST round.
  // `slot.kind === 'flat'` is true for a one-shot game (no def.rounds) AND for
  // round 1 of a staged game (current_round absent/0/garbage → clamped to flat);
  // it is 'keyed' only for round 2+. So a single-round game is byte-identical to
  // today, and a multi-round game (Baxter) skips placement after round 1 — a
  // student who missed day 1 (group_id == null in round 2+) falls through to the
  // game's own absence handling, never re-placed and never marked latecomer_absent.
  if (def.isJoinable && pdata['group_id'] == null && slot.kind === 'flat') {
    const groupsExist = !(await instanceRef.collection('groups').limit(1).get()).empty
    if (groupsExist) {
      const result = await placeLatecomer(def, db, gameInstanceId, participantId)
      if ('absent' in result) {
        // No joinable group. Scoring needs NO change: a participant with no
        // group_id (and not participant_late) is already 'no_show' at finalize
        // (spec §5). participant_late is deliberately NOT set — that is grays'
        // separate 'late' bucket, which this design does not use. latecomer_absent
        // is a UI-only flag driving the student's clear terminal message (§4).
        await participantRef.update({ latecomer_absent: true })
      }
      // Placed → placeLatecomer stamped group_id; the student's waiting room
      // advances exactly as a normally-matched student's does.
    }
  }
}

/**
 * Returns an onCall function that verifies a student-submitted attendance code.
 * On match: sets attendance_confirmed_at on the participant doc and writes the
 * RTDB attending overlay (source for getRoster's display names and real-time list).
 *
 * Gates: participant must exist, confirmed_ready_at must be set, code must match.
 * Idempotent PER ROUND — re-calling after success in the same round is a no-op, but a
 * student confirmed in round 1 can still confirm a rounds-2+ code (Slice 2.6). One-shot
 * games (no def.rounds) behave exactly as before: a single flat attendance_confirmed_at.
 *
 * ROUND-TAG NOTE: the code doc (attendance_code/current) has no round tag. Matching is
 * against whatever code is current, which is correct because the instructor regenerates
 * the code per round (a new code overwrites current). If a future slice wants to reject a
 * stale prior-round code even before regeneration, stamp a round id on the code doc in
 * makeGenerateAttendanceCode and compare it here — out of scope for Slice 2.6.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id }, code: "ABCDE" }
 * Call data (production): Bearer token or { token: "<student classroom JWT>" }, code: "ABCDE"
 * Returns: { ok: true }
 */
export function makeVerifyAttendanceCode(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const code = data.code
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'code is required')
    }

    try {
      await doVerifyAttendanceCode(def, gameInstanceId, participantId, code)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[verifyAttendanceCode] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
