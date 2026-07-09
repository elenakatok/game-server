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
import { resolveRoundSlot, setRoundOutcome, clampRoundIndex } from './roundOutcome'
import type { GameDefinition } from '../GameDefinition'

/** Pure helper — exported for unit testing. Defaults to 5 when absent. */
export function resolveDeadlockThreshold(threshold: number | undefined): number {
  return threshold ?? 5
}

export type OutcomeMechanic = 'unanimous' | 'ultimatum'

/**
 * Which ratification mechanic applies to a given round (pure — exported for unit testing).
 * Per-round override wins, then the whole-game default, then 'unanimous'. A round index is
 * clamped defensively; a one-shot game (no rounds) always resolves the whole-game default.
 */
export function resolveOutcomeMechanic(def: GameDefinition, roundIdx: number): OutcomeMechanic {
  const rounds = def.rounds
  if (rounds && rounds.length > 0 && def.roundOutcomeMechanics) {
    const roundId = rounds[clampRoundIndex(rounds.length, roundIdx)]
    const override = def.roundOutcomeMechanics[roundId]
    if (override) return override
  }
  return def.outcomeMechanic ?? 'unanimous'
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
      const currentRoundPtr = instanceSnap.data()?.['current_round']
      const roundSlot = resolveRoundSlot(def.rounds, currentRoundPtr)
      // Ratification mechanic for this round: 'unanimous' (accept/redo loop) or 'ultimatum'
      // (one decision, reject → terminal no-deal). Absent config → 'unanimous' (unchanged).
      const mechanic = resolveOutcomeMechanic(def, clampRoundIndex(def.rounds?.length ?? 0, currentRoundPtr))

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
        } else if (resolution === 'reset' && mechanic === 'ultimatum') {
          // ULTIMATUM (max-attempts = 1): the receiver's single reject is TERMINAL no-deal for
          // BOTH parties — no reset, no redo, no second offer. Commit a walk-away (null outcome)
          // so the round's EXISTING no-deal handling scores it (per-round no-deal rules are later
          // slices; here we only reach the terminal state). Same round slot as a committed deal.
          tx.update(groupRef, {
            ...setRoundOutcome(roundSlot, null),
            status: 'completed',
            completed_at: FieldValue.serverTimestamp(),
            confirmations: newState.confirmations,
          })
          txOutcome = 'no_deal'
          txLockedOutcome = null
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

      // Write raw_score to each group member immediately after the group locks (a deal OR an
      // ultimatum no-deal — the latter scores every member at the walk-away floor via
      // computeRawScore(role, null)). Best-effort: failure here doesn't roll back the outcome.
      // Finalize/scoreAndRecord recompute the same value (idempotent) and add z-scores unchanged.
      if ((txOutcome === 'locked' || txOutcome === 'no_deal') && txLockedParticipants.length > 0) {
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
