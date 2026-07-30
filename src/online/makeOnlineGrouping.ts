// ═══════════════════════════════════════════════════════════════════════════════
// PRE-GROUPING AT DEPLOY + LOGIN REVEAL + START CLASS.
//
// ── LOCK SCOPE ────────────────────────────────────────────────────────────────
// Re-grouping is the ONE seat action with an INSTANCE-WIDE lock: once ANY group has
// started, re-forming every group is incoherent, so it is refused outright. Move,
// ungroup, fill and swap stay per-group (makeSeatManagement). That asymmetry is
// deliberate and it is what lets the instructor rearrange not-started groups while
// other groups are mid-game.
// ═══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '../auth/instructorAuth'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import {
  authHeaderOf, corsOf, displayNameOf, emailOf, groupsRef, instanceRef, isEmu,
  participantsRef, shuffle, type OnlineContext,
} from './context'
import { toSeatGroup, type GroupDoc } from './groupDocAdapter'
import { chunkIntoGroups, leadOf } from './seatOps'
import type { SeatOccupant } from './types'

export interface GroupingOptions {
  /**
   * Role to stamp on every grouped participant. The stage family assigns roles LATE,
   * so grouping writes one undifferentiated role and the game assigns the real ones
   * at open. A game whose roles matter at match time supplies none and does its own.
   */
  assignRole?: string
}

/**
 * Pre-form groups from the WHOLE roster at deploy time, before anyone logs in.
 *
 * Deliberately includes participants who have never logged in: this is a deploy-time
 * pre-match of everyone enrolled (Online_Matching_Spec §1), so a synced-but-unlaunched
 * roster row must be grouped like any other. Re-runnable until the first group starts.
 *
 * The remainder forms ONE short group rather than being discarded or padded — bot-fill
 * is a separate instructor action, released after the escalation email has had its
 * chance (Online_Matching_Spec §4.5).
 */
export function makeGroupParticipantsOnline(ctx: OnlineContext, opts: GroupingOptions = {}) {
  const { adapter, online } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
    const db = admin.firestore()

    const [groupsSnap, participantsSnap] = await Promise.all([
      groupsRef(gameInstanceId).get(),
      participantsRef(gameInstanceId).get(),
    ])

    // INSTANCE-WIDE lock — the only one. Re-forming groups after play has begun
    // would fork a live game.
    const anyStarted = groupsSnap.docs.some((d) => adapter.hasStarted(d.data() as GroupDoc))
    if (anyStarted) {
      throw new HttpsError(
        'failed-precondition',
        'A group has already started playing, so groups can no longer be re-formed.',
      )
    }

    const humans = participantsSnap.docs.filter((d) => (d.data() as Record<string, unknown>)['is_bot'] !== true)
    if (humans.length === 0) {
      throw new HttpsError('failed-precondition', 'No participants on the roster to group yet.')
    }

    const batch = db.batch()
    // Re-run: drop every prior group and every seat-filler bot. Bots are formation
    // artifacts, re-created on demand, never carried across a re-group.
    for (const g of groupsSnap.docs) batch.delete(g.ref)
    for (const p of participantsSnap.docs) {
      if ((p.data() as Record<string, unknown>)['is_bot'] === true) batch.delete(p.ref)
    }

    const dataById = new Map(humans.map((d) => [d.id, d.data() as Record<string, unknown>]))
    const chunks = chunkIntoGroups(shuffle(humans.map((d) => d.id)), online.seatCount)
    const now = FieldValue.serverTimestamp()
    const created: { group_id: string; size: number }[] = []

    for (const pids of chunks) {
      const groupId = randomUUID()
      const occupants: SeatOccupant[] = pids.map((pid) => {
        const d = dataById.get(pid) ?? {}
        return {
          participantId: pid,
          isBot: false,
          role: opts.assignRole ?? ((d['role'] as string | undefined) ?? null),
          displayName: displayNameOf(d, pid),
          email: emailOf(d),
          ...(d['last_login_at'] != null ? { lastLoginAt: d['last_login_at'] } : {}),
        }
      })
      const lead = occupants[0]?.participantId ?? null

      batch.set(groupsRef(gameInstanceId).doc(groupId), adapter.newGroupFields({
        groupId, gameInstanceId, existing: null, occupants, lead, now,
      }))

      for (const o of occupants) {
        const patch: Record<string, unknown> = {
          group_id: groupId,
          is_lead: o.participantId === lead,
          display_name: o.displayName,
        }
        if (opts.assignRole) {
          patch['role'] = opts.assignRole
          patch['role_assigned_at'] = now
        }
        batch.update(participantsRef(gameInstanceId).doc(o.participantId), patch)
      }
      created.push({ group_id: groupId, size: pids.length })
    }

    // One batch (Firestore caps at 500 ops). Classroom-sized cohorts stay well under;
    // a ~120-student roster would need chunking.
    await batch.commit()

    const short = created.find((g) => g.size < online.seatCount)
    return {
      ok: true as const,
      groups: created.length,
      full_groups: created.filter((g) => g.size === online.seatCount).length,
      short_group_size: short?.size ?? null,
      total_humans: humans.length,
      seat_count: online.seatCount,
    }
  })
}

/**
 * Stamp last_login_at, and denormalise it onto the group so the instructor panel —
 * which reads the GROUP doc — shows login status without a second fetch.
 *
 * ALSO HANDS BACK clock_mode, AND THAT IS LOAD-BEARING. It is the student UI's only way
 * to learn whether it is in an online or a classroom session: config/main is server-only
 * readable, so the client cannot look for itself. Every routeToPhase reads this one field
 * and falls back to CLASSROOM routing when it is missing — which is what happened while
 * this factory returned only { ok, group_id }. An online student was then sent down the
 * classroom join path: "only continue if you are in class right now" → the attendance-code
 * screen → "no attendance code has been generated yet", for a code that cannot exist in a
 * session with no class to display one at. Crisis was unaffected only because it kept a
 * LOCAL recordLogin that always returned clock_mode; this brings the shared factory into
 * line with it, so every game that consumes it routes online students correctly.
 *
 * group_id is still returned — it was never wrong, just insufficient.
 */
export function makeRecordLogin(ctx: OnlineContext) {
  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))

    const pRef = participantsRef(gameInstanceId).doc(participantId)
    const [pSnap, configSnap] = await Promise.all([
      pRef.get(),
      instanceRef(gameInstanceId).collection('config').doc('main').get(),
    ])
    await pRef.set({ last_login_at: FieldValue.serverTimestamp() }, { merge: true })

    const groupId = (pSnap.data()?.['group_id'] as string | undefined) ?? null
    if (groupId) {
      // Nested-map merge, so it never clobbers another member's entry.
      await groupsRef(gameInstanceId).doc(groupId)
        .set({ member_logins: { [participantId]: FieldValue.serverTimestamp() } }, { merge: true })
        .catch(() => { /* cosmetic; the participant stamp is the source of truth */ })
    }
    // Same default as every other clock_mode reader: absent/unset means CLASSROOM.
    const clockMode = String(configSnap.data()?.['clock_mode'] ?? 'on')
    return { ok: true as const, group_id: groupId, clock_mode: clockMode }
  })
}

export interface StartAllGroupsOptions {
  /**
   * Open ONE group's game. Game-specific and injected — the shared machinery has no
   * idea what starting means for a given game. Must be idempotent: a re-press must
   * never reset a group that started between the read and the write.
   */
  openGroup: (gameInstanceId: string, groupId: string) => Promise<void>
  /**
   * Group ids already running. Injected because "already started" is game-specific
   * (Crisis: a crisis_round doc exists), and one read beats N.
   */
  runningGroupIds: (gameInstanceId: string) => Promise<Set<string>>
}

/**
 * ONE "Start class" button. Opens every group that is ready — full and not already
 * running — and skips the rest.
 *
 * RE-PRESSABLE by design: a later press starts groups that became ready since (the
 * latecomer case, or a group just bot-filled), leaving running groups untouched.
 * A short group is SKIPPED rather than refused, so one incomplete group never blocks
 * the class.
 */
export function makeStartAllGroups(ctx: OnlineContext, opts: StartAllGroupsOptions) {
  const { adapter, online } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))

    const [groupsSnap, running] = await Promise.all([
      groupsRef(gameInstanceId).get(),
      opts.runningGroupIds(gameInstanceId),
    ])

    const sortedIds = groupsSnap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b))
    const numberById = new Map(sortedIds.map((id, i) => [id, i + 1]))
    const docById = new Map(groupsSnap.docs.map((d) => [d.id, d.data() as GroupDoc]))

    const results: {
      groupId: string; groupNumber: number
      result: 'started' | 'skipped_short' | 'already_running'; size?: number
    }[] = []
    let started = 0, skippedShort = 0, alreadyRunning = 0

    for (const gid of sortedIds) {
      const gn = numberById.get(gid) ?? 0
      if (running.has(gid)) {
        results.push({ groupId: gid, groupNumber: gn, result: 'already_running' }); alreadyRunning++; continue
      }
      const group = toSeatGroup(adapter, gid, docById.get(gid) ?? {})
      if (group.occupants.length !== online.seatCount) {
        results.push({ groupId: gid, groupNumber: gn, result: 'skipped_short', size: group.occupants.length })
        skippedShort++
        continue
      }
      await opts.openGroup(gameInstanceId, gid)
      results.push({ groupId: gid, groupNumber: gn, result: 'started' }); started++
    }

    return {
      ok: true as const,
      started, skipped_short: skippedShort, already_running: alreadyRunning,
      groups: results,
    }
  })
}

export { instanceRef, leadOf }
