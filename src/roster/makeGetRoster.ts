import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { roleKeys, labelFor, isValidRole, fieldFor, type RoleConfig } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

export type ParticipantRow = {
  participant_id: string
  /** Student-chosen name (RTDB overlay) → Firestore display_name → Firestore name → id prefix. */
  display_name: string
  role: string | null
  role_label: string | null
  group_id: string | null
  is_lead: boolean | null
  attended: boolean
  finalized: boolean
  has_prep_completed: boolean
  is_late: boolean
  raw_score: number | null
}

export type GroupRow = {
  group_id: string
  status: string
  lead_participant_id: string | null
  participants_by_role: Record<string, string[]>
  agreement_reached: boolean | null
  outcome: Record<string, unknown> | null
}

/** Pure helper — exported for unit testing. */
export function mapParticipant(
  id: string,
  data: Record<string, unknown>,
  attendingEntry: { display_name?: string } | null | undefined,
  roles: RoleConfig,
): ParticipantRow {
  const role = typeof data['role'] === 'string' ? data['role'] : null
  const firestoreName = ((data['display_name'] ?? data['name'] ?? '') as string).trim()
  const display_name =
    (attendingEntry?.display_name?.trim()) ||
    firestoreName ||
    id.slice(0, 8) + '…'

  return {
    participant_id: id,
    display_name,
    role,
    role_label: role !== null && isValidRole(roles, role) ? labelFor(roles, role) : null,
    group_id: (data['group_id'] as string | undefined) ?? null,
    is_lead: (data['is_lead'] as boolean | undefined) ?? null,
    attended: data['attendance_confirmed_at'] != null,
    finalized: data['finalized_at'] != null,
    has_prep_completed: data['prep_completed_at'] != null,
    is_late: data['participant_late'] === true,
    raw_score: typeof data['raw_score'] === 'number' ? data['raw_score'] : null,
  }
}

/** Pure helper — exported for unit testing. */
export function mapGroup(
  id: string,
  data: Record<string, unknown>,
  roles: RoleConfig,
): GroupRow {
  const keys = roleKeys(roles)
  return {
    group_id: (data['group_id'] as string | undefined) ?? id,
    status: (data['status'] as string | undefined) ?? '',
    lead_participant_id: (data['lead_participant_id'] as string | undefined) ?? null,
    participants_by_role: Object.fromEntries(
      keys.map(k => [k, (data[fieldFor(k, 'participants')] ?? []) as string[]])
    ),
    agreement_reached: (data['agreement_reached'] ?? null) as boolean | null,
    outcome: (data['outcome'] ?? null) as Record<string, unknown> | null,
  }
}

/**
 * Returns an onCall function that reads the full instructor roster for a game instance.
 * Merges Firestore participants + groups with the RTDB attending overlay for display names.
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token (Authorization header) or { token: "<classroom JWT>" }
 * Returns: { ok: true, participants, groups, session_live }
 */
export function makeGetRoster(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const [participantsSnap, groupsSnap, attendingSnap, attendanceCodeSnap, instanceSnap] = await Promise.all([
        instanceRef.collection('participants').get(),
        instanceRef.collection('groups').get(),
        admin.database().ref(`attending/${gameInstanceId}`).once('value'),
        instanceRef.collection('attendance_code').doc('current').get(),
        instanceRef.get(),
      ])

      const attending = (attendingSnap.val() ?? {}) as Record<
        string,
        { display_name?: string } | null
      >

      const participants: ParticipantRow[] = participantsSnap.docs.map(doc =>
        mapParticipant(doc.id, doc.data() as Record<string, unknown>, attending[doc.id], def.roles)
      )

      const groups: GroupRow[] = groupsSnap.docs.map(doc =>
        mapGroup(doc.id, doc.data() as Record<string, unknown>, def.roles)
      )

      // Staging (opt-in): a game that declares def.rounds is multi-round. One-shot
      // games leave rounds null and current_round 0 — the dashboard renders no round
      // UI, behaving exactly as before.
      const rounds = def.rounds ?? null
      const storedRound = instanceSnap.data()?.['current_round']
      const current_round = (typeof storedRound === 'number' && Number.isInteger(storedRound)) ? storedRound : 0

      return {
        ok: true as const,
        participants,
        groups,
        session_live: attendanceCodeSnap.exists,
        // Server-truth finalized marker (Fix 3): survives dashboard refresh so the
        // Finalize button stays "✓ Finalized" instead of re-enabling on reload.
        finalized: (instanceSnap.data()?.['finalized_at'] ?? null) != null,
        // Staging state (null rounds → one-shot; dashboard shows no round UI).
        rounds,
        current_round,
      }
    } catch (err) {
      console.error('[getRoster] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
