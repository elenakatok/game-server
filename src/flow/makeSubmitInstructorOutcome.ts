import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { validateOutcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns an onCall function for instructor deadlock override.
 *
 * Accepts { group_id, outcome } where outcome is a validated deal object,
 * null (no deal), or { no_deal: true } (legacy shape from Winemaster dashboard).
 * Validates non-null outcomes against def.outcomeSchema.
 * Sets the group to completed with instructor_override: true.
 *
 * Call data (emulator): { _dev: { game_instance_id }, group_id, outcome }
 * Call data (production): Bearer token or { token }, group_id, outcome
 * Returns: { ok: true }
 */
export function makeSubmitInstructorOutcome(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    const groupId = data['group_id']
    if (typeof groupId !== 'string' || !groupId) {
      throw new HttpsError('invalid-argument', 'group_id is required')
    }

    const rawOutcome = data['outcome'] ?? null
    const isNoDeal =
      rawOutcome === null ||
      (typeof rawOutcome === 'object' &&
        !Array.isArray(rawOutcome) &&
        (rawOutcome as Record<string, unknown>)['no_deal'] === true)

    let finalOutcome: Record<string, unknown> | null = null
    if (!isNoDeal) {
      if (typeof rawOutcome !== 'object' || Array.isArray(rawOutcome)) {
        throw new HttpsError('invalid-argument', 'outcome must be an object, null, or { no_deal: true }')
      }
      const validation = validateOutcome(def.outcomeSchema, rawOutcome as Record<string, unknown>)
      if (!validation.valid) {
        throw new HttpsError('invalid-argument', `Invalid outcome: ${validation.errors.join('; ')}`)
      }
      finalOutcome = rawOutcome as Record<string, unknown>
    }

    try {
      const db = admin.firestore()
      const groupRef = db
        .collection('game_instances').doc(gameInstanceId)
        .collection('groups').doc(groupId)

      const gSnap = await groupRef.get()
      if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
      if (gSnap.data()!['status'] === 'completed') {
        throw new HttpsError('failed-precondition', 'Group outcome already locked.')
      }

      await groupRef.update({
        status: 'completed',
        outcome: finalOutcome,
        agreement_reached: finalOutcome !== null,
        completed_at: FieldValue.serverTimestamp(),
        instructor_override: true,
      })

      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[submitInstructorOutcome] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
