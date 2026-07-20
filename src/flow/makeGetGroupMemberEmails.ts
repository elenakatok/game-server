import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'

/**
 * Returns the email addresses of the CALLER'S OWN group members, for display
 * under their names on the group-reveal screen.
 *
 * WHY A CALLABLE RATHER THAN A CLIENT READ. Two more obvious routes are both
 * closed:
 *
 *   • A direct Firestore read of the other members' participant docs is denied
 *     by every game's rules — `allow read: if request.auth.uid == participantId`
 *     lets a student read only their own row.
 *   • Putting email on the group doc would expose it far too widely: groups are
 *     `allow read: if request.auth != null`, so every authenticated student in
 *     the instance could read every group's addresses.
 *
 * Nor does email go into RTDB `attending`, which is world-readable and already
 * the subject of a parked FERPA lockdown; adding addresses there would widen an
 * exposure that is already considered a problem.
 *
 * This function is the narrow alternative: the server resolves the caller's own
 * group from their participant doc, so a student can only ever obtain addresses
 * for the handful of people they were matched with and are about to meet
 * face-to-face.
 *
 * Role-agnostic: member ids are collected from every `*_participants` array on
 * the group doc, so this works for any game's role set with no configuration.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): Bearer token or { token }
 * Returns: { ok: true, members: [{ participant_id, email }] } — members with no
 * email are omitted entirely, so the caller never has to filter blanks.
 */
export function makeGetGroupMemberEmails(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      const pSnap = await instanceRef.collection('participants').doc(participantId).get()
      if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')

      const groupId = pSnap.data()!['group_id'] as string | undefined
      // Not matched yet is a normal state on this screen, not an error.
      if (!groupId) return { ok: true as const, members: [] }

      const gSnap = await instanceRef.collection('groups').doc(groupId).get()
      if (!gSnap.exists) return { ok: true as const, members: [] }

      const memberIds = new Set<string>()
      for (const [key, value] of Object.entries(gSnap.data()!)) {
        if (key.endsWith('_participants') && Array.isArray(value)) {
          for (const id of value) if (typeof id === 'string') memberIds.add(id)
        }
      }

      // The group came from the caller's own participant doc, so this should
      // always hold; asserted anyway so a malformed group can never widen the
      // set of addresses a student can reach.
      if (!memberIds.has(participantId)) {
        throw new HttpsError('permission-denied', 'Not a member of this group.')
      }

      const ids = [...memberIds]
      const snaps = await db.getAll(
        ...ids.map((id) => instanceRef.collection('participants').doc(id)),
      )

      const members = snaps
        .map((snap, i) => ({
          participant_id: ids[i],
          email: ((snap.data()?.['email'] as string | undefined) ?? '').trim(),
        }))
        .filter((m) => m.email !== '')

      return { ok: true as const, members }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[getGroupMemberEmails] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
