import { randomUUID } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { matchParticipants, roleKeys, isValidRole, fieldFor } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'
import { spreadExtras } from './spreadExtras'

/** Pure helper — exported for unit testing. */
export function resolvePerRoleCap(perRoleCap: number | undefined, eligibleCount: number): number {
  return perRoleCap ?? eligibleCount
}

/** One confirmed student, reduced to what the plan needs. */
export type MatchCandidate = { participant_id: string; role: string }

/** What a match over a given pool WOULD produce — the dashboard's pre-match preview. */
export type MatchPlan = {
  /** Students who entered the attendance code and hold a valid role. */
  confirmed: number
  by_role: Record<string, number>
  /** Complete groups that will form (base groups, plus the remnant group if any). */
  groups: number
  /** Per role, students left over once every complete group is filled. */
  extras_by_role: Record<string, number>
  /** False when not even one group can form — matching would refuse. */
  feasible: boolean
}

/**
 * Pure helper — exported for unit testing. Mirrors the arithmetic of
 * matchParticipants (base groups, then the opt-in remnant group, then extras)
 * WITHOUT shuffling or assigning anyone, so the preview and the real match can
 * never disagree about counts.
 */
export function planMatch(
  eligible: MatchCandidate[],
  def: Pick<GameDefinition, 'roles' | 'composition' | 'remnantGroup'>,
): MatchPlan {
  const keys = roleKeys(def.roles)
  const byRole: Record<string, number> = {}
  for (const k of keys) byRole[k] = eligible.filter(p => p.role === k).length
  const base = keys.length === 0
    ? 0
    : Math.min(...keys.map(k => Math.floor(byRole[k] / (def.composition[k] ?? 1))))
  const left: Record<string, number> = {}
  for (const k of keys) left[k] = byRole[k] - base * (def.composition[k] ?? 1)
  let groups = base
  const rem = def.remnantGroup?.composition
  if (rem && Object.keys(rem).length > 0 && Object.entries(rem).every(([k, c]) => (left[k] ?? 0) >= c)) {
    for (const [k, c] of Object.entries(rem)) left[k] -= c
    groups += 1
  }
  return { confirmed: eligible.length, by_role: byRole, groups, extras_by_role: left, feasible: groups > 0 }
}

/**
 * Returns an onCall function that runs the matching algorithm for a game instance.
 *
 * ELIGIBLE = entered the attendance code + holds a valid role. The code IS the proof of
 * presence (Elena, 2026-10-05). A live RTDB connection at the instant of the click is
 * deliberately NOT required: a phone mid-reload dropped a confirmed student out of a
 * 5+5 class, which then matched as 4 pairs and a group of three. Students who are
 * confirmed but not connected are still matched, and are NAMED in the preview.
 *
 * Writes group docs and stamps group_id / is_lead on each participant.
 * Idempotent: if groups already exist, returns them without re-running.
 *
 * perRoleCap absent → uses eligible.length (place every extra, no group fills up).
 * Lead designation comes from matchParticipants (first of first role after shuffle).
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Optional flags:
 *   preview: true  → writes NOTHING; returns { ok, preview: MatchPlan & { not_connected } }.
 *   rematch: true  → discard the existing groups and match afresh. Refused once ANY
 *                    group has left 'matched' (re-forming would fork a live negotiation).
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

      const preview = data['preview'] === true
      const rematch = data['rematch'] === true

      // Idempotency: return existing groups if matching already ran.
      const existingGroupsSnap = await instanceRef.collection('groups').get()
      if (!existingGroupsSnap.empty && !rematch) {
        const groups = existingGroupsSnap.docs.map(d => {
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

      // Re-match is INSTANCE-WIDE and only while every group is still 'matched' — the
      // same rule as the online re-group. One started group forbids it.
      if (rematch && existingGroupsSnap.docs.some(d => d.data()['status'] !== 'matched')) {
        throw new HttpsError(
          'failed-precondition',
          'A group has already started, so the class can no longer be re-matched.',
        )
      }

      // Read RTDB presence and all participant docs in parallel.
      const [presenceSnap, participantsSnap] = await Promise.all([
        admin.database().ref(`presence/${gameInstanceId}`).once('value'),
        instanceRef.collection('participants').get(),
      ])
      const presenceVal = (presenceSnap.val() ?? {}) as Record<string, { online?: boolean } | null>
      const isConnected = (pid: string) => presenceVal[pid] != null && presenceVal[pid]?.online !== false

      // Eligible: entered the attendance code + valid role. NOT gated on a live
      // connection (see the factory comment) — the code is the proof of presence.
      const eligibleDocs = participantsSnap.docs.filter(doc => {
        const d = doc.data()
        return d['attendance_confirmed_at'] != null && isValidRole(def.roles, d['role'] as string)
      })
      const eligible = eligibleDocs.map(doc => ({ participant_id: doc.id, role: doc.data()['role'] as string }))

      if (preview) {
        const not_connected = eligibleDocs
          .filter(doc => !isConnected(doc.id))
          .map(doc => {
            const d = doc.data()
            return {
              participant_id: doc.id,
              display_name: ((d['display_name'] ?? d['name'] ?? '') as string) || doc.id,
              role: d['role'] as string,
            }
          })
        return { ok: true as const, preview: { ...planMatch(eligible, def), not_connected } }
      }

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
      const engineGroups = matchParticipants(eligible, {
        roleConfig: def.roles,
        composition: def.composition,
        perRoleCap: cap,
        ...(def.remnantGroup ? { remnantGroup: def.remnantGroup } : {}),
      })

      // Spread the extras evenly (see spreadExtras). It leaves the engine's placement
      // alone whenever a remnant group has actually formed (Adirondacks).
      const rawGroups = spreadExtras(engineGroups, roleKeyList, def.composition, cap)

      // Batch: write group docs and stamp each participant with group_id and is_lead.
      const batch = db.batch()

      // Re-match: drop the prior groups, and release anyone the new match does not
      // re-place (a re-placed student is simply overwritten below). Same batch, so
      // there is never a moment with two sets of groups.
      if (rematch) {
        for (const g of existingGroupsSnap.docs) batch.delete(g.ref)
        const rePlaced = new Set<string>(
          rawGroups.flatMap(g => roleKeyList.flatMap(k => g[fieldFor(k, 'participants')] as string[])),
        )
        for (const pdoc of participantsSnap.docs) {
          const d = pdoc.data()
          if (rePlaced.has(pdoc.id)) continue
          if (d['group_id'] != null || d['latecomer_absent'] === true) {
            batch.update(pdoc.ref, { group_id: null, is_lead: false, latecomer_absent: FieldValue.delete() })
          }
        }
      }
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
              ...(rematch ? { latecomer_absent: FieldValue.delete() } : {}),
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
