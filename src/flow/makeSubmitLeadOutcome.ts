import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { validateOutcome, initialApprovalState, roleKeys, fieldFor, type OutcomeSchema } from '@mygames/game-engine'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import { clampRoundIndex } from './roundOutcome'
import { getRoundPresence } from '../join/roundPresence'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns an onCall function that records the lead participant's proposed outcome.
 *
 * Validates the submitted outcome against the round's schema (null = no deal, always
 * valid). The round-aware submit flow (opt-in; byte-identical for one-shot games):
 *   • SCHEMA — validates against def.roundOutcomeSchemas[roundId] when the game declares
 *     one for the current round (e.g. Baxter 1983 is a single continuous wage, not the
 *     1978 six-issue contract), else against def.outcomeSchema. Round 1 / a round with no
 *     override / a one-shot game all validate against def.outcomeSchema exactly as before.
 *   • PRESENCE — builds the required-confirmation map over the non-lead participants who
 *     are PRESENT for the current round (getRoundPresence), so a round-absent partner
 *     (e.g. present day-1, absent day-2) cannot block the group's lock. Full-attendance
 *     groups are byte-identical: every group member is present, so no one is excluded.
 * Uses lead_reported_at as the double-submission sentinel — robust to no-deal (null outcome).
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id }, outcome: {...}|null }
 * Call data (production): Bearer token or { token }, outcome: {...}|null
 * Returns: { ok: true }
 */
export function makeSubmitLeadOutcome(def: GameDefinition) {
  const roleKeyList = roleKeys(def.roles)
  /** Resolve which schema to validate a round's outcome against (Option-1 derive). */
  const schemaForRound = (roundIdx: number): OutcomeSchema => {
    const rounds = def.rounds
    if (rounds && def.roundOutcomeSchemas) {
      const roundId = rounds[clampRoundIndex(rounds.length, roundIdx)]
      const override = def.roundOutcomeSchemas[roundId]
      if (override) return override
    }
    return def.outcomeSchema
  }
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

    if (rawOutcome !== null && (typeof rawOutcome !== 'object' || Array.isArray(rawOutcome))) {
      throw new HttpsError('invalid-argument', 'outcome must be an object or null')
    }
    const leadOutcome = rawOutcome as Record<string, unknown> | null

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      // Current round drives BOTH the validation schema and the presence filter below.
      // One-shot games / round 1 clamp to index 0 → the flat behaviour, unchanged.
      const instanceSnap = await instanceRef.get()
      const roundIdx = clampRoundIndex(def.rounds?.length ?? 0, instanceSnap.data()?.['current_round'])

      // Validate the outcome against the ROUND'S schema (null = no deal, always valid).
      if (leadOutcome !== null) {
        const validation = validateOutcome(schemaForRound(roundIdx), leadOutcome)
        if (!validation.valid) {
          throw new HttpsError('invalid-argument', `Invalid outcome: ${validation.errors.join('; ')}`)
        }
      }

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

      // Presence filter: require confirmation only from non-leads PRESENT this round, so a
      // round-absent partner (present day-1, absent day-2) can't block the lock. Full-attendance
      // groups are byte-identical (every member present → nobody excluded). A single Firestore
      // getAll fetches the non-lead docs; an empty set (no present non-leads) is impossible for a
      // reopened group because a whole-role-absent group is deadlocked before it reaches here.
      let requiredIds = nonLeadIds
      if (nonLeadIds.length > 0) {
        const refs = nonLeadIds.map(pid => instanceRef.collection('participants').doc(pid))
        const snaps = await db.getAll(...refs)
        const presentIds = snaps
          .filter(s => s.exists && getRoundPresence(s.data()!, def.rounds, roundIdx))
          .map(s => s.id)
        // Never strip EVERY non-lead: if the presence read yields nobody (unexpected — e.g. a
        // race before presence is written), fall back to the full set rather than auto-locking.
        requiredIds = presentIds.length > 0 ? presentIds : nonLeadIds
      }
      const { confirmations } = initialApprovalState(requiredIds)

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
