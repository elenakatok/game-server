// ═══════════════════════════════════════════════════════════════════════════════
// "I CAN'T REACH MY GROUP" — the flag, and the facts the client needs for its mailto.
//
// Per Online_Matching_Spec §4.1–§4.3:
//   • mailto ONLY. No server-side sending, no form. The message goes out AS THE
//     STUDENT, which is what it already is today.
//   • The flag is PASSIVE — a structured record, not an alerting channel. The email
//     is the alert; Elena may never look at the dashboard.
//   • IDEMPOTENT: the first flag stands. Its timestamp is how long they have been
//     waiting, so a re-press must not reset it.
//   • It goes STALE automatically when the group starts. The majority case resolves
//     itself and needs no cleanup from anyone.
//
// The server supplies only the two facts a client cannot compute: the group's stable
// NUMBER and the instructor's email. The mailto itself is built client-side from the
// member list the waiting screen already has.
// ═══════════════════════════════════════════════════════════════════════════════

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import {
  authHeaderOf, corsOf, groupNumbering, groupsRef, instanceRef, isEmu,
  participantsRef, type OnlineContext,
} from './context'
import { toSeatGroup, type GroupDoc } from './groupDocAdapter'

export interface FlagRecord {
  flagged_at: unknown
  reported_by: string
  reporter_name: string
  /** Members named as not-yet-here, snapshotted at flag time. */
  named: string[]
}

export function makeFlagGroup(ctx: OnlineContext) {
  const { adapter } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
    const db = admin.firestore()

    const [pSnap, groupsSnap, configSnap, instSnap] = await Promise.all([
      participantsRef(gameInstanceId).doc(participantId).get(),
      groupsRef(gameInstanceId).get(),
      instanceRef(gameInstanceId).collection('config').doc('main').get(),
      instanceRef(gameInstanceId).get(),
    ])

    const groupId = pSnap.data()?.['group_id'] as string | undefined
    if (!groupId) throw new HttpsError('failed-precondition', 'You are not in a group yet.')

    const groupNumber = groupNumbering(groupsSnap.docs.map((d) => d.id)).get(groupId) ?? 0
    const gRef = groupsRef(gameInstanceId).doc(groupId)

    const already = await db.runTransaction(async (tx) => {
      const gs = await tx.get(gRef)
      if (!gs.exists) throw new HttpsError('not-found', 'Group not found.')
      const doc = gs.data() as GroupDoc
      if (adapter.hasStarted(doc)) {
        throw new HttpsError('failed-precondition', 'This group has already started playing.')
      }
      if (doc['flag'] != null) return true // idempotent — the first flag stands

      const group = toSeatGroup(adapter, groupId, doc)
      const arrived = new Set(((doc['arrived'] as string[] | undefined) ?? []))
      // "named" = the human members other than the reporter who are not yet here.
      // A snapshot: the live picture can move, the record should not.
      const named = group.occupants
        .filter((o) => !o.isBot && o.participantId !== participantId && !arrived.has(o.participantId))
        .map((o) => o.participantId)
      const reporterName =
        group.occupants.find((o) => o.participantId === participantId)?.displayName ?? participantId

      const flag: FlagRecord = {
        flagged_at: FieldValue.serverTimestamp(),
        reported_by: participantId,
        reporter_name: reporterName,
        named,
      }
      tx.set(gRef, { flag }, { merge: true })
      return false
    })

    // Instructor-email precedence: a MANUAL Settings value wins when set (a real
    // override — a co-teacher, or a correction); otherwise the value synced from the
    // course owner at roster sync (Extraction Spec §7). Null when neither is set, and
    // the client still opens a mailto with the group Cc'd.
    const synced = String(instSnap.data()?.['instructor_email'] ?? '').trim()
    const override = String(configSnap.data()?.['instructor_email'] ?? '').trim()

    return {
      ok: true as const,
      already_flagged: already,
      group_number: groupNumber,
      instructor_email: override || synced || null,
      mail_subject: ctx.online.flagMailSubject ?? null,
    }
  })
}
