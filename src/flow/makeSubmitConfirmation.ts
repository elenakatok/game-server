import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import {
  applyApproval,
  resolveStatus,
  roleKeys,
  fieldFor,
  type ApprovalDecision,
  type ApprovalState,
} from '@mygames/game-engine'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import { resolveRoundSlot, setRoundOutcome } from './roundOutcome'
import type { GameDefinition } from '../GameDefinition'

/** Pure helper — exported for unit testing. Defaults to 5 when absent. */
export function resolveDeadlockThreshold(threshold: number | undefined): number {
  return threshold ?? 5
}

/**
 * Returns an onCall function for a non-lead participant to confirm or reject the lead's outcome.
 *
 * Uses the game-engine approval machine (applyApproval / resolveStatus) — pure reducers.
 * Deadlocks after def.deadlockThreshold (default 5) reset rounds; resets retry the cycle.
 * All reads, logic, and writes are inside a Firestore transaction — concurrent confirmations
 * are serialised; no confirmation can be lost.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id }, confirmed: boolean }
 * Call data (production): Bearer token or { token }, confirmed: boolean
 * Returns: { ok: true, outcome: 'locked' | 'deadlocked' | 'rejected' | 'waiting' }
 */
export function makeSubmitConfirmation(def: GameDefinition) {
  const deadlockAt = resolveDeadlockThreshold(def.deadlockThreshold)
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    if (typeof data['confirmed'] !== 'boolean') {
      throw new HttpsError('invalid-argument', 'confirmed must be boolean')
    }
    const confirmed = data['confirmed']

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const [pSnap, instanceSnap] = await Promise.all([
        instanceRef.collection('participants').doc(participantId).get(),
        instanceRef.get(),
      ])
      if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pdata = pSnap.data()!
      if (!pdata['group_id']) throw new HttpsError('failed-precondition', 'Not in a group.')
      if (pdata['is_lead']) throw new HttpsError('permission-denied', 'Lead uses submitLeadOutcome.')

      // Which round's slot does a lock write to? One-shot games / round 1 → flat
      // `outcome`; rounds 2+ → the keyed map. The proceed gate blocks advance until every
      // group is 'completed', so current_round is stable across an in-progress round.
      const roundSlot = resolveRoundSlot(def.rounds, instanceSnap.data()?.['current_round'])

      const groupRef = instanceRef.collection('groups').doc(pdata['group_id'] as string)

      let txOutcome = 'waiting'
      // Captured when the group locks — used for the post-transaction raw_score write.
      let txLockedOutcome: Record<string, unknown> | null = null
      let txLockedParticipants: Array<{ participantId: string; role: string }> = []

      // All state reads, logic, and writes inside the transaction — concurrent approvals serialised.
      await db.runTransaction(async (tx) => {
        const gSnap = await tx.get(groupRef)
        if (!gSnap.exists) throw new HttpsError('not-found', 'Group not found.')
        const gdata = gSnap.data()!

        if (gdata['status'] !== 'reporting') {
          throw new HttpsError(
            'failed-precondition',
            `Cannot confirm — group is '${gdata['status'] as string}'.`,
          )
        }
        // lead_reported_at is the reliable sentinel: null on reset and null before first submission.
        if (gdata['lead_reported_at'] == null) {
          throw new HttpsError('failed-precondition', 'Lead has not reported yet.')
        }

        const storedConfs = (gdata['confirmations'] ?? {}) as Record<string, ApprovalDecision>
        if (storedConfs[participantId] !== 'pending') {
          throw new HttpsError('failed-precondition', 'Already responded this round.')
        }

        const state: ApprovalState = { confirmations: storedConfs }
        const newState = applyApproval(state, {
          participantId,
          decision: confirmed ? 'confirmed' : 'rejected',
        })
        const resolution = resolveStatus(newState)

        if (resolution === 'committed') {
          const leadOutcome = gdata['lead_outcome'] as Record<string, unknown> | null
          tx.update(groupRef, {
            // Round-1/one-shot → flat `outcome` (+ agreement_reached), byte-identical to
            // before; rounds 2+ → the keyed slot only, leaving round 1 intact.
            ...setRoundOutcome(roundSlot, leadOutcome),
            status: 'completed',
            completed_at: FieldValue.serverTimestamp(),
            confirmations: newState.confirmations,
          })
          txOutcome = 'locked'
          // Capture for the post-transaction raw_score write.
          txLockedOutcome = leadOutcome
          for (const roleKey of roleKeys(def.roles)) {
            const pids = (gdata[fieldFor(roleKey, 'participants')] ?? []) as string[]
            for (const pid of pids) txLockedParticipants.push({ participantId: pid, role: roleKey })
          }
        } else if (resolution === 'reset') {
          const resetCount = ((gdata['reset_count'] as number | undefined) ?? 0) + 1
          if (resetCount >= deadlockAt) {
            tx.update(groupRef, {
              status: 'deadlocked',
              reset_count: resetCount,
              [`confirmations.${participantId}`]: 'rejected',
            })
            txOutcome = 'deadlocked'
          } else {
            // Reset: clear lead submission; set all confirmations back to pending.
            const resetConfs: Record<string, ApprovalDecision> = {}
            for (const pid of Object.keys(storedConfs)) resetConfs[pid] = 'pending'
            tx.update(groupRef, {
              reset_count: resetCount,
              lead_outcome: null,
              lead_reported_at: null,
              confirmations: resetConfs,
            })
            txOutcome = 'rejected'
          }
        } else {
          // 'awaiting': one participant responded, others still pending.
          tx.update(groupRef, { [`confirmations.${participantId}`]: 'confirmed' })
          txOutcome = 'waiting'
        }
      })

      // Write raw_score to each group member immediately after the group locks.
      // Best-effort: failure here doesn't roll back the confirmed outcome.
      // Finalize will recompute the same value (idempotent) and add z-scores unchanged.
      if (txOutcome === 'locked' && txLockedParticipants.length > 0) {
        try {
          const configSnap = await instanceRef.collection('config').doc('main').get()
          const configData = (configSnap.data() ?? {}) as Record<string, unknown>
          const scoreBatch = db.batch()
          for (const { participantId: pid, role } of txLockedParticipants) {
            const rawScore = def.computeRawScore(role, txLockedOutcome, configData)
            scoreBatch.update(
              instanceRef.collection('participants').doc(pid),
              { raw_score: rawScore },
            )
          }
          await scoreBatch.commit()
        } catch (err) {
          console.error('[submitConfirmation] raw_score early write failed (non-fatal):', err)
        }
      }

      return { ok: true as const, outcome: txOutcome }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[submitConfirmation] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
