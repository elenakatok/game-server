import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { computeZScoresByRole, type ScoringRecord, type Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

export type CompletedGroup = {
  outcome: Outcome | null
  agreement_reached: boolean
}

/**
 * Pure helper — exported for unit testing.
 * Returns a ScoringRecord for a participant with a role, or null for roleless participants.
 *
 * Status priority:
 *   completed group found → 'completed'  (deal or walk-away; both stay in the scored pool)
 *   participant_late === true → 'late'    (present but unplaceable; excluded from distribution)
 *   otherwise → 'no_show'               (never matched; excluded; receives −2 floor marker)
 *
 * Knowledge-check score is carried from the Firestore participant doc.
 */
export function buildScoringRecord(
  participantId: string,
  data: Record<string, unknown>,
  completedGroups: Map<string, CompletedGroup>,
): ScoringRecord | null {
  const role = data['role'] as string | undefined
  if (!role) return null

  const groupId = data['group_id'] as string | undefined
  const groupOutcome = groupId ? completedGroups.get(groupId) : undefined

  const status: ScoringRecord['status'] =
    groupOutcome !== undefined ? 'completed'
    : data['participant_late'] === true ? 'late'
    : 'no_show'

  return {
    participant_id: participantId,
    role,
    status,
    agreement_reached: groupOutcome?.agreement_reached ?? false,
    outcome: groupOutcome?.outcome ?? null,
    knowledge_check_score: (data['knowledge_check_score'] ?? null) as number | null,
  }
}

/**
 * Returns an onCall function that finalizes a game instance.
 *
 * Guard: every group must be status:'completed' — returns 400 if any are not yet resolved.
 * Builds ScoringRecord[] adopting grays improvements:
 *   (a) participant_late === true → 'late' classification (excluded from distribution, normalized_score: null)
 *   (b) knowledge_check_score read from Firestore participant doc (not hardcoded null)
 *   (c) roleless participants (enrolled but never joined) receive normalized_score: −2 in a second pass
 *
 * Delegates normalization to game-engine's computeZScoresByRole with def.roles,
 * def.scoreSense, and def.computeRawScore. No scoring constants live in this factory.
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, scored: number }
 */
export function makeFinalizeInstance(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      // 1. Read all groups; guard: every group must be status:'completed'.
      const groupsSnap = await instanceRef.collection('groups').get()
      for (const gdoc of groupsSnap.docs) {
        if (gdoc.data()['status'] !== 'completed') {
          throw new HttpsError(
            'failed-precondition',
            `Group ${gdoc.id} is not resolved — resolve all groups before finalizing.`,
          )
        }
      }

      // Build completed-group lookup: group_id → { outcome, agreement_reached }.
      const completedGroups = new Map<string, CompletedGroup>()
      for (const gdoc of groupsSnap.docs) {
        const d = gdoc.data()
        completedGroups.set(gdoc.id, {
          outcome: (d['outcome'] as Outcome | null) ?? null,
          agreement_reached: Boolean(d['agreement_reached']),
        })
      }

      // 2. Read all participants + config (config feeds reservation prices into scoring).
      const [participantsSnap, configSnap] = await Promise.all([
        instanceRef.collection('participants').get(),
        instanceRef.collection('config').doc('main').get(),
      ])
      const configData = (configSnap.data() ?? {}) as Record<string, unknown>

      // 3. First pass: build ScoringRecord[] for role-bearing participants.
      const records: ScoringRecord[] = []
      for (const pdoc of participantsSnap.docs) {
        const record = buildScoringRecord(
          pdoc.id,
          pdoc.data() as Record<string, unknown>,
          completedGroups,
        )
        if (record !== null) records.push(record)
      }

      // 4. Normalize: game-engine handles per-role pools, sample SD (÷N−1), cost-sense
      //    negation, no_show → −2, late → null, walk-away pool inclusion.
      //    Wrap computeRawScore to thread configData through without changing game-engine types.
      const scorer = (role: string, outcome: Outcome | null) => def.computeRawScore(role, outcome, configData)
      const finalized = computeZScoresByRole(records, def.roles, def.scoreSense, scorer)

      // 5. Write scores for role-bearing participants.
      const now = FieldValue.serverTimestamp()
      const batch = db.batch()
      for (const f of finalized) {
        batch.update(instanceRef.collection('participants').doc(f.participant_id), {
          raw_score: f.raw_score,
          normalized_score: f.normalized_score,
          knowledge_check_score: f.knowledge_check_score,
          finalized_at: now,
        })
      }

      // 6. Second pass: roleless participants (enrolled but never joined).
      //    Excluded from z-score math; receive the −2 floor marker so the push includes them.
      let noRoleCount = 0
      for (const pdoc of participantsSnap.docs) {
        if (pdoc.data()['role']) continue
        batch.update(
          instanceRef.collection('participants').doc(pdoc.id),
          { raw_score: null, normalized_score: -2, finalized_at: now },
        )
        noRoleCount++
      }

      await batch.commit()
      return { ok: true as const, scored: finalized.length + noRoleCount }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[finalizeInstance] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
