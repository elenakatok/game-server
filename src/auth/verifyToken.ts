import * as jwt from 'jsonwebtoken'
import { CLASSROOM_PUBLIC_KEY_PEM } from './classroomPublicKey'

const EXPECTED_ISSUER = 'classroom.mygames.live'
const EXPECTED_KEY_ID = 'classroom-v1'
const ALGORITHM = 'RS256'

export type ClassroomTokenPayload = {
  participant_id: string
  name: string
  course_id: string
  session_id: string
  game_instance_id: string
  game_config_id: string
  role: 'student' | 'instructor'
  classroom_callback_url: string
  callback_secret_id: string
  iat: number
  exp: number
  sub: string
  iss: string
}

/**
 * Verifies a classroom-issued RS256 JWT.
 * Uses the baked-in classroom public key (kid: classroom-v1).
 * Pass a different PEM to override — useful in tests or if the key rotates.
 */
export function verifyClassroomToken(
  token: string,
  publicKey: string = CLASSROOM_PUBLIC_KEY_PEM,
): ClassroomTokenPayload {
  const header = jwt.decode(token, { complete: true })?.header
  if (header?.kid !== EXPECTED_KEY_ID) {
    throw new Error(`Unexpected key id: ${header?.kid ?? '(none)'}`)
  }
  const decoded = jwt.verify(token, publicKey, {
    algorithms: [ALGORITHM],
    issuer: EXPECTED_ISSUER,
  }) as ClassroomTokenPayload
  return decoded
}
