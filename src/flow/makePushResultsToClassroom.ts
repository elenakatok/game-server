import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { roleKeys } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import { dispatchResults, type GameResult } from '../classroom/reportResult'
import type { GameDefinition } from '../GameDefinition'

// Registered at module load so the Firebase CLI knows this function needs the secret.
// All games use 'CLASSROOM_CALLBACK_SECRET' as the secret name in their Firebase project.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/**
 * Returns an onCall function that pushes finalized participant scores to the classroom.
 *
 * Scores-only payload: raw_score intentionally omitted — normalized_score and
 * knowledge_check_score only (classroom gradebook contract).
 * Reads details from the Firestore participant doc.
 * Skips participants that have not been through finalizeInstance (no finalized_at).
 * Skips participants with unrecognised roles (validated via roleKeys(def.roles)).
 *
 * Call data (emulator): { _dev: { game_instance_id, callback_url?, callback_secret? } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, total, succeeded, failed: [{ participant_id, reason }] }
 */
export function makePushResultsToClassroom(def: GameDefinition) {
  const VALID_ROLES = new Set(roleKeys(def.roles))
  return onCall(
    { cors: def.corsOrigins, secrets: [classroomCallbackSecret] },
    async (request) => {
      const data = request.data as Record<string, unknown>
      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
      const authHeader = request.rawRequest.headers.authorization as string | undefined

      const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

      const devBody = isEmulator && data['_dev'] != null
        ? data['_dev'] as Record<string, unknown>
        : null
      const callbackUrl =
        (devBody?.['callback_url'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_URL ?? ''
      const callbackSecret =
        (devBody?.['callback_secret'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_SECRET ?? ''

      console.log('[push] callbackUrl:', callbackUrl || '(empty)',
        '| secretLen:', callbackSecret.length)
      if (!callbackUrl) {
        console.warn('[pushResultsToClassroom] CLASSROOM_CALLBACK_URL not configured — no-op')
        return { ok: true as const, total: 0, succeeded: 0, failed: [] }
      }

      try {
        const db = admin.firestore()
        const snap = await db
          .collection('game_instances')
          .doc(gameInstanceId)
          .collection('participants')
          .get()

        const records: GameResult[] = []
        for (const doc of snap.docs) {
          const d = doc.data()

          // Only push participants that have been through finalizeInstance.
          if (d['finalized_at'] == null) continue

          // Skip participants with an unrecognised NON-null role (instructors, legacy data).
          // Roleless participants (role == null) are kept: these are the no-show absents
          // that finalize marks with normalized_score −2 — they MUST reach the gradebook.
          // (Mirrors grays' own push gate, which gates on finalized_at, not on role.)
          const role = d['role'] as string | null
          if (role != null && !VALID_ROLES.has(role)) continue

          // no_show participants have raw_score: null (set by computeZScoresByRole).
          // Walk-aways have a raw_score → 'completed'.
          const status: GameResult['status'] = d['raw_score'] != null ? 'completed' : 'no_show'

          records.push({
            game_instance_id: gameInstanceId,
            participant_id: doc.id,
            status,
            role,
            normalized_score: (d['normalized_score'] ?? null) as number | null,
            knowledge_check_score: (d['knowledge_check_score'] ?? null) as number | null,
            details: (d['details'] ?? {}) as Record<string, unknown>,
          })
        }

        const summary = await dispatchResults(records, callbackUrl, callbackSecret)
        console.log('[push] summary:', JSON.stringify(summary))
        return { ok: true as const, ...summary }
      } catch (err) {
        if (err instanceof HttpsError) throw err
        console.error('[pushResultsToClassroom] error:', err)
        throw new HttpsError('internal', 'Internal error')
      }
    },
  )
}
