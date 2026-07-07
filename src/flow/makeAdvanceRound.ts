import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

// Round-navigation math — a small self-contained mirror of @mygames/game-engine's
// `rounds` helpers. INLINED (not imported) on purpose: importing it would give
// game-server a build-time type dependency on a sibling git-dep's freshly-built
// .d.ts, which the deploy's nested git-dep `prepare` step cannot reliably resolve.
// The engine `rounds` module remains the canonical general primitive; this is a
// two-line mirror to keep the shared packages build-time-decoupled.
function clampRoundIndex(len: number, stored: unknown): number {
  if (len === 0) return 0
  const i = (typeof stored === 'number' && Number.isInteger(stored)) ? stored : 0
  return Math.max(0, Math.min(i, len - 1))
}

/**
 * Class-level "proceed to next round" gate for a multi-round (staged) game.
 *
 * Modeled on makeFinalizeInstance's all-groups-completed guard: it advances the
 * whole class from the current round to the next only when every group has
 * resolved the current round. Purely ADDITIVE and OPT-IN — a game that does not
 * declare def.rounds simply never exports advanceRound, and nothing here runs.
 *
 * Skeleton scope: this ONLY bumps the instance-level current_round pointer. It does
 * NOT re-open group status (rounds beyond the first have no content yet), so the
 * absorbing 'completed' state and every existing flow are untouched. Re-opening
 * groups for a real subsequent round is a later slice.
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

      // Advance the class-level round pointer. Skeleton: nothing else changes.
      await instanceRef.set({ current_round: nextIdx }, { merge: true })

      return { ok: true as const, current_round: nextIdx, round_id: rounds[nextIdx] }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[advanceRound] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
