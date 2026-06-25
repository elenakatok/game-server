import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns an onCall function that transitions a matched group to negotiating.
 *
 * Any group member may call this. Idempotent: already 'negotiating' is a no-op.
 * Throws if the group is in any other status (reporting, deadlocked, completed).
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): Bearer token or { token }
 * Returns: { ok: true }
 */
export function makeStartNegotiation(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const pSnap = await instanceRef.collection('participants').doc(participantId).get()
      if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pdata = pSnap.data()!
      if (!pdata['group_id']) throw new HttpsError('failed-precondition', 'Not in a group.')

      const groupRef = instanceRef.collection('groups').doc(pdata['group_id'] as string)

      await db.runTransaction(async (tx) => {
        const gSnap = await tx.get(groupRef)
        if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
        const status = gSnap.data()!['status'] as string
        if (status === 'negotiating') return
        if (status !== 'matched') {
          throw new HttpsError('failed-precondition', `Cannot start negotiation — group is '${status}'.`)
        }
        tx.update(groupRef, {
          status: 'negotiating',
          negotiation_started_at: FieldValue.serverTimestamp(),
        })
      })

      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[startNegotiation] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
