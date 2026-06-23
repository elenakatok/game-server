import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

async function markPrepComplete(gameInstanceId: string, participantId: string): Promise<void> {
  const ref = admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)

  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Participant not found.')
  if (snap.data()?.prep_status === 'complete') return

  await ref.update({
    prep_status: 'complete',
    prep_completed_at: FieldValue.serverTimestamp(),
  })
}

/**
 * Returns an onCall function that marks a participant's preparation as complete.
 * Idempotent — safe to call on every mount of the hold screen.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): Bearer token or { token: "<student classroom JWT>" }
 * Returns: { ok: true }
 */
export function makeCompletePrep(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    try {
      await markPrepComplete(gameInstanceId, participantId)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[completePrep] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
