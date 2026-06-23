import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

async function markReadyConfirmed(gameInstanceId: string, participantId: string): Promise<void> {
  const ref = admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)

  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Participant not found.')

  const data = snap.data()!
  if (data.prep_status !== 'complete') {
    throw new HttpsError('failed-precondition', 'Preparation not complete.')
  }
  if (data.confirmed_ready_at != null) return

  await ref.update({ confirmed_ready_at: FieldValue.serverTimestamp() })
}

/**
 * Returns an onCall function that records a participant's readiness for live session.
 * Requires prep_status === 'complete'. Idempotent.
 * This is the gate verifyAttendanceCode requires.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): Bearer token or { token: "<student classroom JWT>" }
 * Returns: { ok: true }
 */
export function makeConfirmReady(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    try {
      await markReadyConfirmed(gameInstanceId, participantId)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[confirmReady] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
