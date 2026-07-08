import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { validateOutcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import { resolveRoundSlot, setRoundOutcome } from './roundOutcome'
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
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)
      const groupRef = instanceRef.collection('groups').doc(groupId)

      const [gSnap, instanceSnap] = await Promise.all([groupRef.get(), instanceRef.get()])
      if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
      // Per-round lock: 'completed' means THIS round is resolved. advanceRound re-opens
      // groups to 'negotiating' for the next round, so a later round records freely while
      // the same round still cannot be re-recorded.
      if (gSnap.data()!['status'] === 'completed') {
        throw new HttpsError('failed-precondition', 'Group outcome already locked.')
      }

      // Round-1/one-shot → flat `outcome`; rounds 2+ → the keyed slot (round 1 preserved).
      const roundSlot = resolveRoundSlot(def.rounds, instanceSnap.data()?.['current_round'])

      await groupRef.update({
        status: 'completed',
        ...setRoundOutcome(roundSlot, finalOutcome),
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
