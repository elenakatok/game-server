import { HttpsError } from 'firebase-functions/v2/https'
import { verifyClassroomToken, type ClassroomTokenPayload } from './verifyToken'
import { verifyFirebaseToken } from './verifyFirebaseToken'

/**
 * Extracts and validates the instructor's game_instance_id from an onCall request.
 * Throws HttpsError on any auth failure — never returns null.
 *
 * Auth paths (in order):
 *   1. Emulator dev bypass:   data._dev.game_instance_id  (FUNCTIONS_EMULATOR only)
 *   2. Firebase Bearer token: Authorization: Bearer <instructor id token>  (role must be 'instructor')
 *   3. Classroom JWT:         data.token  (RS256, role must be 'instructor')
 */
export async function extractInstructorGameId(
  data: Record<string, unknown>,
  isEmulator: boolean,
  authHeader?: string,
): Promise<string> {
  if (isEmulator && data._dev != null) {
    const dev = data._dev as Record<string, unknown>
    if (typeof dev.game_instance_id !== 'string') {
      throw new HttpsError('invalid-argument', '_dev requires game_instance_id')
    }
    return dev.game_instance_id
  }
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { gameInstanceId, role } = await verifyFirebaseToken(authHeader)
      if (role !== 'instructor') {
        throw new HttpsError('permission-denied', 'Instructor access required')
      }
      return gameInstanceId
    } catch (err) {
      if (err instanceof HttpsError) throw err
      const message = err instanceof Error ? err.message : 'Invalid token'
      throw new HttpsError('unauthenticated', message)
    }
  }
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
    throw new HttpsError('permission-denied', 'Instructor access required')
  }
  return payload.game_instance_id
}
