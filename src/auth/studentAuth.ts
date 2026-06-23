import { verifyClassroomToken, type ClassroomTokenPayload } from './verifyToken'
import { verifyFirebaseToken } from './verifyFirebaseToken'

export type MinimalResponse = {
  status: (code: number) => { json: (body: object) => void }
}

/**
 * Extracts participant_id and game_instance_id from an HTTP request.
 * Returns { participantId, gameInstanceId } on success, or null (after writing an error) on failure.
 *
 * Auth paths (in order):
 *   1. Emulator _test bypass:    body._test.{ participant_id, game_instance_id }
 *   2. Firebase Bearer token:    Authorization: Bearer <student id token>  (role must be 'student')
 *   3. Classroom JWT:            body.token  (RS256; participant_id + game_instance_id in payload)
 */
export async function extractStudentIds(
  body: Record<string, unknown>,
  isEmulator: boolean,
  res: MinimalResponse,
  authHeader?: string,
): Promise<{ participantId: string; gameInstanceId: string } | null> {
  if (isEmulator && body._test != null) {
    const test = body._test as Record<string, unknown>
    if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
      res.status(400).json({ error: '_test requires participant_id and game_instance_id strings' })
      return null
    }
    return { participantId: test.participant_id, gameInstanceId: test.game_instance_id }
  }
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const { uid, gameInstanceId, role } = await verifyFirebaseToken(authHeader)
      if (role !== 'student') {
        res.status(403).json({ error: 'Student access required' })
        return null
      }
      return { participantId: uid, gameInstanceId }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token'
      res.status(401).json({ error: message })
      return null
    }
  }
  if (typeof body.token !== 'string') {
    res.status(400).json({ error: 'Missing token' })
    return null
  }
  let payload: ClassroomTokenPayload
  try {
    payload = verifyClassroomToken(body.token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid token'
    res.status(401).json({ error: message })
    return null
  }
  return { participantId: payload.participant_id, gameInstanceId: payload.game_instance_id }
}
