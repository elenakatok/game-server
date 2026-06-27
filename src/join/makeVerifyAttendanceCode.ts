import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

async function doVerifyAttendanceCode(
  gameInstanceId: string,
  participantId: string,
  submittedCode: string,
): Promise<void> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)
  const codeRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('attendance_code').doc('current')

  const [participantSnap, codeSnap] = await Promise.all([
    participantRef.get(),
    codeRef.get(),
  ])

  if (!participantSnap.exists) throw new HttpsError('not-found', 'Participant not found.')

  const pdata = participantSnap.data()!

  if (pdata.confirmed_ready_at == null) {
    throw new HttpsError('failed-precondition', 'Please complete the confirmation step first.')
  }

  // Idempotent: already verified.
  if (pdata.attendance_confirmed_at != null) return

  if (!codeSnap.exists) {
    throw new HttpsError(
      'failed-precondition',
      'No attendance code has been generated yet. Ask your instructor to display one.',
    )
  }

  const storedCode = (codeSnap.data()!.code as string).toUpperCase()
  if (submittedCode.toUpperCase().trim() !== storedCode) {
    throw new HttpsError(
      'invalid-argument',
      "That code doesn't match. Check what your instructor is displaying and try again.",
    )
  }

  await participantRef.update({
    attendance_confirmed_at: FieldValue.serverTimestamp(),
  })

  // Write to RTDB so the instructor dashboard shows a real-time attendance list.
  // This path is persistent (never deleted on disconnect).
  await admin.database()
    .ref(`attending/${gameInstanceId}/${participantId}`)
    .set({
      display_name: (pdata.display_name as string | undefined) ?? (pdata.name as string | undefined) ?? '',
      role: pdata.role ?? '',
      confirmed_at: Date.now(),
    })
}

/**
 * Returns an onCall function that verifies a student-submitted attendance code.
 * On match: sets attendance_confirmed_at on the participant doc and writes the
 * RTDB attending overlay (source for getRoster's display names and real-time list).
 *
 * Gates: participant must exist, confirmed_ready_at must be set, code must match.
 * Idempotent — re-calling after success is a no-op.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id }, code: "ABCDE" }
 * Call data (production): Bearer token or { token: "<student classroom JWT>" }, code: "ABCDE"
 * Returns: { ok: true }
 */
export function makeVerifyAttendanceCode(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const code = data.code
    if (typeof code !== 'string' || code.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'code is required')
    }

    try {
      await doVerifyAttendanceCode(gameInstanceId, participantId, code)
      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[verifyAttendanceCode] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
