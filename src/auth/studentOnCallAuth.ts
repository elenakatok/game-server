import { HttpsError } from 'firebase-functions/v2/https'
import { verifyClassroomToken } from './verifyToken'
import { verifyFirebaseToken } from './verifyFirebaseToken'

/**
 * Extracts participant_id and game_instance_id from an onCall request.
 * Throws HttpsError on any auth failure — never returns null.
 *
 * Auth paths (in order):
 *   1. Emulator _test bypass:   data._test.{ participant_id, game_instance_id }
 *   2. Firebase Bearer token:   Authorization: Bearer <student id token>
 *   3. Classroom JWT:           data.token  (RS256; participant_id + game_instance_id in payload)
 */
export async function extractStudentOnCallIds(
  data: Record<string, unknown>,
  isEmulator: boolean,
  authHeader?: string,
): Promise<{ participantId: string; gameInstanceId: string }> {
  if (isEmulator && data._test != null) {
    const test = data._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      throw new HttpsError('invalid-argument', '_test requires participant_id and game_instance_id strings')
    }
    return { participantId: test.participant_id, gameInstanceId: test.game_instance_id }
  }
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { uid, gameInstanceId, role } = await verifyFirebaseToken(authHeader)
      if (role !== 'student') {
        throw new HttpsError('permission-denied', 'Student access required')
      }
      return { participantId: uid, gameInstanceId }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      const message = err instanceof Error ? err.message : 'Invalid token'
      throw new HttpsError('unauthenticated', message)
    }
  }
  if (typeof data.token !== 'string') {
    throw new HttpsError('invalid-argument', 'Missing token')
  }
  try {
    const payload = verifyClassroomToken(data.token)
    return { participantId: payload.participant_id, gameInstanceId: payload.game_instance_id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    throw new HttpsError('unauthenticated', message)
  }
}
