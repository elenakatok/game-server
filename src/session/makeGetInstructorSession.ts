import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { verifyClassroomToken, type ClassroomTokenPayload } from '../auth/verifyToken'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns an onCall function that exchanges an instructor classroom JWT for a
 * Firebase custom token. The custom token lets the dashboard hold an
 * auto-refreshing Firebase session (signInWithCustomToken) for Bearer auth on
 * all subsequent instructor-gated calls.
 *
 * This is the bootstrap step — it cannot use Firebase Bearer auth since it is
 * what mints the session. It always validates via classroom JWT (or emulator bypass).
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): { token: "<instructor classroom JWT>" }
 * Returns: { ok: true, customToken }
 */
export function makeGetInstructorSession(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    let gameInstanceId: string

    if (isEmulator && data._dev != null) {
      const dev = data._dev as Record<string, unknown>
      if (typeof dev.game_instance_id !== 'string') {
        throw new HttpsError('invalid-argument', '_dev requires game_instance_id')
      }
      gameInstanceId = dev.game_instance_id
    } else {
      if (typeof data.token !== 'string') {
        throw new HttpsError('invalid-argument', 'Missing token')
      }
      let payload: ClassroomTokenPayload
      try {
        payload = verifyClassroomToken(data.token)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token'
        throw new HttpsError('unauthenticated', message)
      }
      if (payload.role !== 'instructor') {
        throw new HttpsError('permission-denied', 'not instructor')
      }
      gameInstanceId = payload.game_instance_id
    }

    try {
      const uid = `instructor_${gameInstanceId}`
      const customToken = await admin.auth().createCustomToken(uid, {
        role: 'instructor',
        game_instance_id: gameInstanceId,
      })
      return { ok: true as const, customToken }
    } catch (err) {
      console.error('[getInstructorSession] createCustomToken error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
