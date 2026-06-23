import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

// Unambiguous uppercase chars: no I (→1), L (→1), O (→0).
const CODE_CHARS = 'ABCDEFGHJKMNPQRTUVWXY'
const CODE_LENGTH = 5

function makeCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

async function doGenerateAttendanceCode(gameInstanceId: string): Promise<string> {
  const code = makeCode()
  await admin.firestore()
    .collection('game_instances').doc(gameInstanceId)
    .collection('attendance_code').doc('current')
    .set({ code, generated_at: FieldValue.serverTimestamp() })
  return code
}

/**
 * Returns an onCall function that generates a 5-char attendance code for a game instance.
 * Called by the instructor dashboard ("Show Code" action). Always overwrites existing code.
 * The stored path (attendance_code/current) is what getRoster reads for session_live.
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, code: "ABCDE" }
 */
export function makeGenerateAttendanceCode(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const code = await doGenerateAttendanceCode(gameInstanceId)
      return { ok: true as const, code }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[generateAttendanceCode] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
