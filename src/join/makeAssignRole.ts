import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { roleKeys, fieldFor } from '@mygames/game-engine'
import { verifyClassroomToken } from '../auth/verifyToken'
import type { GameDefinition } from '../GameDefinition'

/**
 * Pure balance helper — exported for unit testing.
 *
 * Picks the role whose current count is furthest below its share of the target
 * composition. Comparison is fill-fraction: counts[key] / (composition[key] ?? 1).
 * For symmetric games every composition value is 1, so the fraction equals the
 * raw count — identical to the previous behaviour byte-for-byte.
 * On ties, picks the first declared role (stable, same as before).
 */
export function pickRole(
  keys: string[],
  counts: Record<string, number>,
  composition: Record<string, number> = {},
): string {
  let minRole  = keys[0]
  let minRatio = (counts[keys[0]] ?? 0) / (composition[keys[0]] ?? 1)
  for (const key of keys.slice(1)) {
    const ratio = (counts[key] ?? 0) / (composition[key] ?? 1)
    if (ratio < minRatio) { minRole = key; minRatio = ratio }
  }
  return minRole
}

export async function doAssignRole(
  gameInstanceId: string,
  participantId: string,
  roleKeyList: string[],
  composition: Record<string, number>,
  displayName?: string,
): Promise<string> {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const participantRef = instanceRef.collection('participants').doc(participantId)
  const countsRef = instanceRef.collection('role_counts').doc('totals')

  return db.runTransaction(async (tx) => {
    const [participantSnap, countsSnap] = await Promise.all([
      tx.get(participantRef),
      tx.get(countsRef),
    ])

    const existing = participantSnap.data()
    // Short-circuit preserved: a role, once assigned, is never re-assigned — so the
    // back-fill below runs exactly once, at first role acquisition.
    if (existing?.role) return existing.role as string

    // Role-timing back-fill target (ROLE_TIMING_BACKFILL_CHECK.md §5): a participant already
    // PLACED into a group (group_id set) before they had a role — the move/ungroup panel's
    // "placed-then-role" case. In the normal match-first flow there is no group_id here, so
    // groupRef stays null and nothing extra is read or written (the path is byte-for-byte
    // unchanged for those callers). Read the group INSIDE the txn, before any write (Firestore
    // requires all reads first) — so the group_id is known from participantSnap above.
    const groupId = (existing?.['group_id'] as string | undefined) ?? null
    const groupRef = groupId ? instanceRef.collection('groups').doc(groupId) : null
    const groupSnap = groupRef ? await tx.get(groupRef) : null
    const gdata = groupSnap?.exists ? (groupSnap.data() ?? {}) : null
    // A group left with no lead (rare) gets this newly-rolled member as its lead, mirroring
    // matching/moveSeat which always leave a group with a lead.
    const becomesLead = gdata != null && !gdata['lead_participant_id']

    const counts = (countsSnap.data() ?? {}) as Record<string, number>
    const role = pickRole(roleKeyList, counts, composition)
    const now = FieldValue.serverTimestamp()

    if (participantSnap.exists) {
      tx.update(participantRef, { role, role_assigned_at: now, ...(becomesLead ? { is_lead: true } : {}) })
    } else {
      // A new participant doc has no group_id, so this branch never back-fills.
      tx.set(participantRef, {
        participant_id: participantId,
        game_instance_id: gameInstanceId,
        role,
        role_assigned_at: now,
        prep_status: 'not_started',
        ...(displayName ? { display_name: displayName } : {}),
      })
    }
    tx.set(countsRef, { [role]: (counts[role] ?? 0) + 1 }, { merge: true })

    // ── Back-fill the group's role array ──────────────────────────────────────────
    // The student was placed while role-less, so writeMembership/newGroupFields filed them
    // into NO <role>_participants array. Now that they have a role, add them there so they
    // render on the member-list surfaces (GroupReveal / Results / GroupMembersPanel all read
    // these arrays). arrayUnion is idempotent + concurrency-safe: a re-run or a racing double
    // never double-adds, and a member already present (the already-role'd-then-moved case,
    // which never reaches here anyway) is a no-op.
    if (gdata != null) {
      const patch: Record<string, unknown> = {
        [fieldFor(role, 'participants')]: FieldValue.arrayUnion(participantId),
      }
      if (becomesLead) patch['lead_participant_id'] = participantId
      tx.update(groupRef!, patch)
    }

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
  const roleKeyList  = roleKeys(def.roles)
  const composition  = def.composition
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    let participantId: string
    let gameInstanceId: string
    let displayName: string | undefined

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
        participantId  = payload.participant_id
        gameInstanceId = payload.game_instance_id
        displayName    = payload.name
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid token'
        throw new HttpsError('unauthenticated', message)
      }
    }

    try {
      const role = await doAssignRole(gameInstanceId, participantId, roleKeyList, composition, displayName)
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
