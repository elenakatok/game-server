// ═══════════════════════════════════════════════════════════════════════════════
// SEAT MANAGEMENT — the instructor's per-group actions.
//
//   moveSeat              move / ungroup / place-into-a-new-group (one callable)
//   topUpGroupWithBots    fill empty seats so a short group can play
//
// ── LOCK SCOPE, preserved verbatim from Crisis O2.1/O2.2 ──────────────────────
// These are PER-GROUP actions, gated only on the source and destination groups'
// own `started` flags. They are NOT gated on any instance-wide lock: the instructor
// rearranges not-started groups while other groups are mid-game. Only re-group and
// the mode switch are instance-wide (see makeOnlineGrouping).
//
// All the logic that can corrupt data lives in the PURE seatOps; these are thin
// transactional shells over it.
// ═══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '../auth/instructorAuth'
import {
  authHeaderOf, corsOf, displayNameOf, emailOf, groupsRef, instanceRef, isEmu,
  participantsRef, requireArg, throwSeatRejection, type OnlineContext,
} from './context'
import { toSeatGroup, type GroupDoc } from './groupDocAdapter'
import { fillWithBots, leadOf, moveOccupant } from './seatOps'
import type { SeatGroup, SeatOccupant } from './types'

/**
 * Sentinels on the SAME callable, so a game binds ONE function rather than three:
 *   ''    → ungroup (remove from the current group; the group stays standing)
 *   'new' → place into a brand-new group of their own
 *   else  → a real group id
 * Group ids are UUIDs, so neither sentinel can collide with one.
 */
export const UNGROUP = ''
export const NEW_GROUP = 'new'

/** Read a participant doc into a seat occupant. */
function occupantOf(participantId: string, data: Record<string, unknown>): SeatOccupant {
  return {
    participantId,
    isBot: data['is_bot'] === true,
    role: (data['role'] as string | undefined) ?? null,
    displayName: displayNameOf(data, participantId),
    email: emailOf(data),
    ...(data['last_login_at'] != null ? { lastLoginAt: data['last_login_at'] } : {}),
  }
}

/**
 * Re-read every human occupant's participant doc so the denormalised membership
 * (names, emails, logins) is rebuilt from truth rather than carried forward stale.
 */
async function hydrate(
  tx: FirebaseFirestore.Transaction,
  gameInstanceId: string,
  group: SeatGroup,
): Promise<SeatGroup> {
  const humans = group.occupants.filter((o) => !o.isBot)
  if (humans.length === 0) return group
  const snaps = await tx.getAll(
    ...humans.map((h) => participantsRef(gameInstanceId).doc(h.participantId)),
  )
  const byId = new Map(snaps.map((s) => [s.id, (s.data() ?? {}) as Record<string, unknown>]))
  return {
    ...group,
    occupants: group.occupants.map((o) =>
      o.isBot ? o : { ...o, ...occupantOf(o.participantId, byId.get(o.participantId) ?? {}) },
    ),
  }
}

export function makeMoveSeat(ctx: OnlineContext) {
  const { adapter, online } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const participantId = requireArg(data, 'participant_id')
    const targetGroupId = String(data['target_group_id'] ?? '')

    const db = admin.firestore()
    return db.runTransaction(async (tx) => {
      // ── reads first (Firestore requires it) ──
      const pRef = participantsRef(gameInstanceId).doc(participantId)
      const pSnap = await tx.get(pRef)
      if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pData = pSnap.data() as Record<string, unknown>
      if (pData['is_bot'] === true) {
        throw new HttpsError('failed-precondition', 'Only human participants can be moved.')
      }

      const sourceGroupId = (pData['group_id'] as string | undefined) ?? null
      const creatingNew = targetGroupId === NEW_GROUP
      const realTargetId = creatingNew ? randomUUID() : targetGroupId || null

      let sourceDoc: GroupDoc | null = null
      let source: SeatGroup | null = null
      if (sourceGroupId) {
        const s = await tx.get(groupsRef(gameInstanceId).doc(sourceGroupId))
        if (s.exists) {
          sourceDoc = s.data() as GroupDoc
          source = await hydrate(tx, gameInstanceId, toSeatGroup(adapter, sourceGroupId, sourceDoc))
        }
      }

      let targetDoc: GroupDoc | null = null
      let target: SeatGroup | null = null
      if (realTargetId && !creatingNew) {
        const t = await tx.get(groupsRef(gameInstanceId).doc(realTargetId))
        if (!t.exists) throw new HttpsError('not-found', 'Group not found.')
        targetDoc = t.data() as GroupDoc
        target = await hydrate(tx, gameInstanceId, toSeatGroup(adapter, realTargetId, targetDoc))
      } else if (creatingNew) {
        target = { groupId: realTargetId as string, occupants: [], started: false }
      }

      // ── the pure operation ──
      const result = moveOccupant({
        participantId,
        source,
        target,
        seatCount: online.seatCount,
        occupant: occupantOf(participantId, pData),
      })
      if (!result.ok) throwSeatRejection(result.reason)
      if (result.noop) {
        return { ok: true as const, moved: false, reason: 'already in the destination' }
      }

      // ── writes ──
      const now = FieldValue.serverTimestamp()

      if (result.source) {
        const lead = leadOf(result.source)
        tx.update(
          groupsRef(gameInstanceId).doc(result.source.groupId),
          adapter.writeMembership({ existing: sourceDoc, occupants: result.source.occupants, lead }),
        )
        for (const o of result.source.occupants) {
          if (!o.isBot) {
            tx.update(participantsRef(gameInstanceId).doc(o.participantId), { is_lead: o.participantId === lead })
          }
        }
      }

      if (result.target) {
        const lead = leadOf(result.target)
        const ref = groupsRef(gameInstanceId).doc(result.target.groupId)
        if (creatingNew) {
          tx.set(ref, adapter.newGroupFields({
            groupId: result.target.groupId,
            gameInstanceId,
            existing: null,
            occupants: result.target.occupants,
            lead,
            now,
          }))
        } else {
          const patch = adapter.writeMembership({
            existing: targetDoc,
            occupants: result.target.occupants,
            lead,
          })
          if (result.evictedBot && online.botGroupFields) {
            Object.assign(patch, online.botGroupFields(
              result.target.occupants.filter((o) => o.isBot),
              targetDoc ?? {},
            ))
          }
          tx.update(ref, patch)
        }
        for (const o of result.target.occupants) {
          if (!o.isBot && o.participantId !== participantId) {
            tx.update(participantsRef(gameInstanceId).doc(o.participantId), { is_lead: o.participantId === lead })
          }
        }
        tx.update(pRef, { group_id: result.target.groupId, is_lead: participantId === lead })
      } else {
        // UNGROUP: the participant becomes unassigned. Never deleted — "ungrouped"
        // is a state, and they appear in the No Group pool to be placed again.
        tx.update(pRef, { group_id: null, is_lead: false })
      }

      // An evicted bot owns nothing but its own doc (the group is unlocked, so it has
      // no round data). Removing it keeps the pool of participants honest.
      if (result.evictedBot) {
        tx.delete(participantsRef(gameInstanceId).doc(result.evictedBot))
      }

      return {
        ok: true as const,
        moved: true,
        source_group: result.source?.groupId ?? null,
        target_group: result.target?.groupId ?? null,
        created_group: creatingNew ? result.target?.groupId ?? null : null,
        evicted_bot: result.evictedBot,
      }
    })
  })
}

export function makeTopUpGroupWithBots(ctx: OnlineContext) {
  const { adapter, online } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const groupId = requireArg(data, 'group_id')

    const db = admin.firestore()
    const gRef = groupsRef(gameInstanceId).doc(groupId)
    const snap = await gRef.get()
    if (!snap.exists) throw new HttpsError('not-found', 'Group not found.')
    const doc = snap.data() as GroupDoc
    const group = toSeatGroup(adapter, groupId, doc)

    const minted: { participantId: string; doc: Record<string, unknown> }[] = []
    const result = fillWithBots({
      group,
      seatCount: online.seatCount,
      mint: (index) => {
        const seat = online.makeBotSeat({ gameInstanceId, groupId, index })
        minted.push(seat)
        return { participantId: seat.participantId, isBot: true, role: (seat.doc['role'] as string) ?? null }
      },
    })
    if (!result.ok) throwSeatRejection(result.reason)
    if (result.added.length === 0) return { ok: true as const, added: 0, reason: 'group already full' }

    const batch = db.batch()
    for (const m of minted) {
      batch.set(participantsRef(gameInstanceId).doc(m.participantId), m.doc)
    }
    const patch = adapter.writeMembership({
      existing: doc,
      occupants: result.group.occupants,
      lead: leadOf(result.group),
    })
    if (online.botGroupFields) {
      Object.assign(patch, online.botGroupFields(result.group.occupants.filter((o) => o.isBot), doc))
    }
    batch.update(gRef, patch)
    await batch.commit()

    return { ok: true as const, added: result.added.length, bots: minted.map((m) => m.participantId) }
  })
}

/**
 * The instructor's read side: online groups with their members, plus the No Group
 * pool. Served here because the instructor client cannot read participant docs
 * directly (firestore rules), so names have to come from the server.
 *
 * The pool includes LATE roster additions — anyone non-bot with no group_id, whether
 * they were ungrouped, never matched, or synced after grouping ran.
 */
export function makeGetOnlineGroups(ctx: OnlineContext) {
  const { adapter, online } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))

    const [groupsSnap, participantsSnap] = await Promise.all([
      groupsRef(gameInstanceId).get(),
      participantsRef(gameInstanceId).get(),
    ])

    const nameById = new Map<string, string>()
    for (const p of participantsSnap.docs) {
      nameById.set(p.id, displayNameOf(p.data() as Record<string, unknown>, p.id))
    }

    const sortedIds = groupsSnap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b))
    const numberById = new Map(sortedIds.map((id, i) => [id, i + 1]))

    const groups = groupsSnap.docs.map((d) => {
      const doc = d.data() as GroupDoc
      const g = toSeatGroup(adapter, d.id, doc)
      return {
        group_id: d.id,
        group_number: numberById.get(d.id) ?? 0,
        started: g.started,
        seat_count: online.seatCount,
        free_seats: Math.max(0, online.seatCount - g.occupants.length),
        occupants: g.occupants.map((o) => ({
          participant_id: o.participantId,
          display_name: o.isBot ? (o.displayName ?? o.participantId) : (nameById.get(o.participantId) ?? o.participantId),
          email: o.email ?? null,
          is_bot: o.isBot,
        })),
      }
    }).sort((a, b) => a.group_number - b.group_number)

    const noGroup = participantsSnap.docs
      .filter((p) => {
        const d = p.data() as Record<string, unknown>
        return d['is_bot'] !== true && d['group_id'] == null
      })
      .map((p) => ({ participant_id: p.id, display_name: nameById.get(p.id) ?? p.id }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name))

    return { ok: true as const, seat_count: online.seatCount, groups, no_group: noGroup }
  })
}

/** Exported for the emulator harness and for a game that wants the core directly. */
export const seatManagementInternals = { occupantOf, hydrate }

export type { GroupDoc }
export { instanceRef }
