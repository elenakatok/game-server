import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { roleKeys } from '@mygames/game-engine'
import { verifyClassroomToken } from '../auth/verifyToken'
import type { GameDefinition } from '../GameDefinition'

/** Pure balance helper — exported for unit testing. */
export function pickRole(keys: string[], counts: Record<string, number>): string {
  let minRole = keys[0]
  let minCount = counts[keys[0]] ?? 0
  for (const key of keys.slice(1)) {
    const c = counts[key] ?? 0
    if (c < minCount) { minRole = key; minCount = c }
  }
  return minRole
}

async function doAssignRole(
  gameInstanceId: string,
  participantId: string,
  roleKeyList: string[],
): Promise<string> {
  const db = admin.firestore()
  const participantRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('participants').doc(participantId)
  const countsRef = db
    .collection('game_instances').doc(gameInstanceId)
    .collection('role_counts').doc('totals')

  return db.runTransaction(async (tx) => {
    const [participantSnap, countsSnap] = await Promise.all([
      tx.get(participantRef),
      tx.get(countsRef),
    ])

    const existing = participantSnap.data()
    if (existing?.role) return existing.role as string

    const counts = (countsSnap.data() ?? {}) as Record<string, number>
    const role = pickRole(roleKeyList, counts)
    const now = FieldValue.serverTimestamp()

    if (participantSnap.exists) {
      tx.update(participantRef, { role, role_assigned_at: now })
    } else {
      tx.set(participantRef, {
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        role,
        role_assigned_at: now,
        prep_status: 'not_started',
      })
    }
    tx.set(countsRef, { [role]: (counts[role] ?? 0) + 1 }, { merge: true })
    return role
  })
}

/**
 * Returns an onCall function that assigns a role to a student and mints their Firebase session.
 *
 * This is the student bootstrap — verifies a classroom JWT and creates a Firebase custom token.
 * Cannot use Firebase Bearer auth: this is what mints the student session.
 * Custom token claims: { game_instance_id } only — no role claim (students differ from instructors).
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): { token: "<student classroom JWT>" }
 * Returns: { ok: true, role, customToken, participant_id, game_instance_id }
 */
export function makeAssignRole(def: GameDefinition) {
  const roleKeyList = roleKeys(def.roles)
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    let participantId: string
    let gameInstanceId: string

    if (isEmulator && data._test != null) {
      const test = data._test as Record<string, unknown>
      if (typeof test.participant_id !== 'string' || typeof test.game_instance_id !== 'string') {
        throw new HttpsError('invalid-argument', '_test requires participant_id and game_instance_id strings')
      }
      participantId = test.participant_id
      gameInstanceId = test.game_instance_id
    } else {
      if (typeof data.token !== 'string') {
        throw new HttpsError('invalid-argument', 'Missing token')
      }
      try {
        const payload = verifyClassroomToken(data.token)
        participantId = payload.participant_id
        gameInstanceId = payload.game_instance_id
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token'
        throw new HttpsError('unauthenticated', message)
      }
    }

    try {
      const role = await doAssignRole(gameInstanceId, participantId, roleKeyList)
      const customToken = await admin.auth().createCustomToken(participantId, {
        game_instance_id: gameInstanceId,
      })
      return {
        ok: true as const,
        role,
        customToken,
        participant_id: participantId,
        game_instance_id: gameInstanceId,
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[assignRole] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
