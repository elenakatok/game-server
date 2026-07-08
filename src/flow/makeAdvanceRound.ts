import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '../auth/instructorAuth'
import { clampRoundIndex } from './roundOutcome'
import type { GameDefinition } from '../GameDefinition'

// Round-navigation math lives in ./roundOutcome (clampRoundIndex) — a game-server-local
// module, deliberately NOT imported from @mygames/game-engine's `rounds` helpers:
// importing the engine git-dep would give game-server a build-time dependency on a
// sibling's freshly-built .d.ts, which the deploy's nested git-dep `prepare` step cannot
// reliably resolve. The engine `rounds` module remains the canonical general primitive;
// roundOutcome mirrors just the two lines the flows need, keeping the packages decoupled.

/**
 * Class-level "proceed to next round" gate for a multi-round (staged) game.
 *
 * Modeled on makeFinalizeInstance's all-groups-completed guard: it advances the
 * whole class from the current round to the next only when every group has
 * resolved the current round. Purely ADDITIVE and OPT-IN — a game that does not
 * declare def.rounds simply never exports advanceRound, and nothing here runs.
 *
 * Slice 2.5: on advance, every group is RE-OPENED to 'negotiating' so the new round
 * can be negotiated, reported, and reach 'deadlocked' — lifting the previously
 * absorbing 'completed' state. Re-open only clears the transient per-round working
 * fields (lead submission, confirmations, reset/lock markers); it NEVER touches the
 * stored round outcomes (round-1 flat `outcome` and the `outcomes_by_round` map both
 * survive). Purely staged-game behaviour: one-shot games never declare def.rounds, so
 * they never reach this factory and are byte-identical to before.
 *
 * Returns onCall: { ok, current_round, round_id }.
 */
export function makeAdvanceRound(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined
    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const rounds = def.rounds
    if (!rounds || rounds.length === 0) {
      throw new HttpsError('failed-precondition', 'This game is not multi-round.')
    }

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const [instanceSnap, groupsSnap] = await Promise.all([
        instanceRef.get(),
        instanceRef.collection('groups').get(),
      ])

      const storedRound = instanceSnap.data()?.['current_round']
      const currentIdx = clampRoundIndex(rounds.length, storedRound)
      const nextIdx = currentIdx < rounds.length - 1 ? currentIdx + 1 : null
      if (nextIdx === null) {
        throw new HttpsError('failed-precondition', `Already at the final round (${rounds[currentIdx]}).`)
      }

      // Guard (cloned from finalize's all-groups gate): every group must have
      // resolved the current round before the class advances.
      if (groupsSnap.empty) {
        throw new HttpsError('failed-precondition', 'No groups yet — cannot advance rounds.')
      }
      for (const gdoc of groupsSnap.docs) {
        if (gdoc.data()['status'] !== 'completed') {
          throw new HttpsError(
            'failed-precondition',
            `Group ${gdoc.id} has not resolved round ${rounds[currentIdx]} — resolve all groups before proceeding.`,
          )
        }
      }

      // Advance atomically: bump the class-level round pointer AND re-open every group
      // for the new round in a single batch. Re-open resets only the transient working
      // fields; the round-1 flat `outcome` and the `outcomes_by_round` map are left in
      // place so prior-round data is preserved. status:'negotiating' lets the lead report
      // the new round (submitLeadOutcome accepts 'negotiating'); cleared lead_reported_at
      // /confirmations/reset_count re-arm the confirmation cycle; the removed completed_at
      // /instructor_override drop the previous round's lock so this round is unlocked while
      // that round's outcome stays recorded in its slot.
      const batch = db.batch()
      for (const gdoc of groupsSnap.docs) {
        batch.update(gdoc.ref, {
          status: 'negotiating',
          negotiation_started_at: FieldValue.serverTimestamp(),
          lead_outcome: null,
          lead_reported_at: null,
          confirmations: {},
          reset_count: 0,
          completed_at: FieldValue.delete(),
          instructor_override: FieldValue.delete(),
        })
      }
      batch.set(instanceRef, { current_round: nextIdx }, { merge: true })
      await batch.commit()

      return { ok: true as const, current_round: nextIdx, round_id: rounds[nextIdx] }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[advanceRound] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
