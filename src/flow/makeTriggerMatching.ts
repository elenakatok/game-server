import { randomUUID } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { matchParticipants, roleKeys, isValidRole, fieldFor } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

/** Pure helper — exported for unit testing. */
export function resolvePerRoleCap(perRoleCap: number | undefined, eligibleCount: number): number {
  return perRoleCap ?? eligibleCount
}

/**
 * Returns an onCall function that runs the matching algorithm for a game instance.
 * Eligible participants: attendance verified + valid role + present in RTDB presence.
 * Writes group docs and stamps group_id / is_lead on each participant.
 * Idempotent: if groups already exist, returns them without re-running.
 *
 * perRoleCap absent → uses eligible.length (place every extra, no group fills up).
 * Lead designation comes from matchParticipants (first of first role after shuffle).
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, groups, alreadyMatched? }
 */
export function makeTriggerMatching(def: GameDefinition) {
  const roleKeyList = roleKeys(def.roles)
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      // Idempotency: return existing groups if matching already ran.
      const existingSnap = await instanceRef.collection('groups').limit(1).get()
      if (!existingSnap.empty) {
        const allSnap = await instanceRef.collection('groups').get()
        const groups = allSnap.docs.map(d => {
          const gdata = d.data()
          return {
            group_id: gdata['group_id'] as string,
            game_instance_id: gdata['game_instance_id'] as string,
            lead_participant_id: gdata['lead_participant_id'] as string,
            outcome: gdata['outcome'] as null,
            status: gdata['status'] as string,
            ...Object.fromEntries(
              roleKeyList.map(k => [fieldFor(k, 'participants'), gdata[fieldFor(k, 'participants')] as string[]])
            ),
          }
        })
        return { ok: true as const, groups, alreadyMatched: true }
      }

      // Read RTDB presence and all participant docs in parallel.
      const [presenceSnap, participantsSnap] = await Promise.all([
        admin.database().ref(`presence/${gameInstanceId}`).once('value'),
        instanceRef.collection('participants').get(),
      ])
      const presentIds = new Set<string>(Object.keys((presenceSnap.val() ?? {}) as object))

      // Eligible: attended + valid role + present in RTDB.
      const eligible = participantsSnap.docs
        .filter(doc => {
          const d = doc.data()
          return (
            d['attendance_confirmed_at'] != null &&
            isValidRole(def.roles, d['role'] as string) &&
            presentIds.has(doc.id)
          )
        })
        .map(doc => ({ participant_id: doc.id, role: doc.data()['role'] as string }))

      // Guard: need enough eligible participants of each role to form at least one base group.
      const baseGroupCount = roleKeyList.length === 0
        ? 0
        : Math.min(
            ...roleKeyList.map(k =>
              Math.floor(eligible.filter(p => p.role === k).length / (def.composition[k] ?? 1))
            )
          )
      // Remnant fallback: even with zero full base groups, an instance with ≥1 of every
      // remnant role can still form the single one-per-role remnant group (Adirondacks).
      const remnantFeasible = def.remnantGroup != null &&
        Object.entries(def.remnantGroup.composition).every(([k, c]) =>
          eligible.filter(p => p.role === k).length >= c
        )
      if (baseGroupCount === 0 && !remnantFeasible) {
        throw new HttpsError(
          'failed-precondition',
          'Not enough participants to form a group (need at least one full base group of each role present).',
        )
      }

      const cap = resolvePerRoleCap(def.perRoleCap, eligible.length)
      const rawGroups = matchParticipants(eligible, {
        roleConfig: def.roles,
        composition: def.composition,
        perRoleCap: cap,
        ...(def.remnantGroup ? { remnantGroup: def.remnantGroup } : {}),
      })

      // Batch: write group docs and stamp each participant with group_id and is_lead.
      const batch = db.batch()
      const groups = rawGroups.map(g => {
        const groupId = randomUUID()
        const groupRef = instanceRef.collection('groups').doc(groupId)
        const roleFields = Object.fromEntries(
          roleKeyList.map(k => [fieldFor(k, 'participants'), g[fieldFor(k, 'participants')] as string[]])
        )
        batch.set(groupRef, {
          group_id: groupId,
          game_instance_id: gameInstanceId,
          lead_participant_id: g.lead_participant_id,
          outcome: null,
          ...roleFields,
          status: 'matched',
          matched_at: FieldValue.serverTimestamp(),
        })
        for (const key of roleKeyList) {
          for (const pid of g[fieldFor(key, 'participants')] as string[]) {
            batch.update(instanceRef.collection('participants').doc(pid), {
              group_id: groupId,
              is_lead: pid === g.lead_participant_id,
            })
          }
        }
        return {
          group_id: groupId,
          game_instance_id: gameInstanceId,
          lead_participant_id: g.lead_participant_id,
          outcome: null as null,
          status: 'matched',
          ...roleFields,
        }
      })

      await batch.commit()
      return { ok: true as const, groups }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[triggerMatching] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
