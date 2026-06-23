import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { validateOutcome, initialApprovalState, roleKeys, fieldFor } from '@mygames/game-engine'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns an onCall function that records the lead participant's proposed outcome.
 *
 * Validates the submitted outcome against def.outcomeSchema (null = no deal, always valid).
 * Builds the initial confirmation map over all non-lead participants using roleKeys(def.roles).
 * Uses lead_reported_at as the double-submission sentinel — robust to no-deal (null outcome).
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id }, outcome: {...}|null }
 * Call data (production): Bearer token or { token }, outcome: {...}|null
 * Returns: { ok: true }
 */
export function makeSubmitLeadOutcome(def: GameDefinition) {
  const roleKeyList = roleKeys(def.roles)
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    // Require 'outcome' key; null = no deal.
    if (!('outcome' in data)) {
      throw new HttpsError('invalid-argument', 'outcome is required (use null for no deal)')
    }
    const rawOutcome = data['outcome']

    if (rawOutcome !== null) {
      if (typeof rawOutcome !== 'object' || Array.isArray(rawOutcome)) {
        throw new HttpsError('invalid-argument', 'outcome must be an object or null')
      }
      const validation = validateOutcome(def.outcomeSchema, rawOutcome as Record<string, unknown>)
      if (!validation.valid) {
        throw new HttpsError('invalid-argument', `Invalid outcome: ${validation.errors.join('; ')}`)
      }
    }
    const leadOutcome = rawOutcome as Record<string, unknown> | null

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const pSnap = await instanceRef.collection('participants').doc(participantId).get()
      if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pdata = pSnap.data()!
      if (!pdata['group_id']) throw new HttpsError('failed-precondition', 'Not in a group.')
      if (!pdata['is_lead']) throw new HttpsError('permission-denied', 'Only the lead can report the outcome.')

      const groupRef = instanceRef.collection('groups').doc(pdata['group_id'] as string)
      const gSnap = await groupRef.get()
      if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
      const gdata = gSnap.data()!

      if (gdata['status'] === 'completed') {
        throw new HttpsError('failed-precondition', 'Outcome already locked.')
      }
      if (gdata['status'] === 'deadlocked') {
        throw new HttpsError('failed-precondition', 'Group is deadlocked — awaiting instructor.')
      }
      // lead_reported_at sentinel: robust to no-deal (lead_outcome is null on both reset and valid no-deal).
      if (gdata['status'] === 'reporting' && gdata['lead_reported_at'] != null) {
        throw new HttpsError('failed-precondition', 'Already submitted this round. Waiting for group to review.')
      }

      // Collect all pids using role-driven field access; filter out the lead.
      const allPids: string[] = []
      for (const key of roleKeyList) {
        const pids = gdata[fieldFor(key, 'participants')] as string[] | undefined
        if (pids) allPids.push(...pids)
      }
      const nonLeadIds = allPids.filter(pid => pid !== (gdata['lead_participant_id'] as string))
      const { confirmations } = initialApprovalState(nonLeadIds)

      await groupRef.update({
        status: 'reporting',
        lead_outcome: leadOutcome,
        lead_reported_at: FieldValue.serverTimestamp(),
        confirmations,
      })
      return { ok: true as const }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[submitLeadOutcome] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
