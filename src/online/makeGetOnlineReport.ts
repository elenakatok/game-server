// ═══════════════════════════════════════════════════════════════════════════════
// THE ASSIGNMENT-STATUS REPORT (Online_Matching_Spec §6).
//
// The "who do I email / how do I grade" view: which groups finished, are mid-game,
// or never started; and per student — their group, whether they arrived, last login,
// whether they were flagged, whether they played with bots.
//
// It COMPOSES the two absence signals the spec wants side by side: the flag records
// unresponsiveness BEFORE play, the game's own progress records absence DURING play.
// Having both in one place is genuinely more information than exists anywhere else.
//
// Per-group PROGRESS is injected, because what "finished" means is game-specific and
// the shared machinery must not guess.
// ═══════════════════════════════════════════════════════════════════════════════

import { onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { extractInstructorGameId } from '../auth/instructorAuth'
import {
  authHeaderOf, corsOf, displayNameOf, groupNumbering, groupsRef, isEmu,
  participantsRef, type OnlineContext,
} from './context'
import { toSeatGroup, type GroupDoc } from './groupDocAdapter'

export type GroupCategory = 'finished' | 'in_progress' | 'never_started'

export interface GroupProgress {
  category: GroupCategory
  /** Rounds recorded so far — whatever the game counts. */
  rounds: number
  /** Per-participant in-play absence count (Crisis: stage timeouts). */
  absencesByParticipant?: Record<string, number>
}

export interface OnlineReportOptions {
  /**
   * Per-group progress, keyed by group id. Injected: only the game knows what
   * "finished" means. A group absent from the map is treated as never started.
   */
  progressOf: (gameInstanceId: string) => Promise<Map<string, GroupProgress>>
  /** Column label for the in-play absence count. Game copy. */
  absenceLabel?: string
}

export function makeGetOnlineReport(ctx: OnlineContext, opts: OnlineReportOptions) {
  const { adapter } = ctx

  return onCall(corsOf(ctx), async (request: CallableRequest) => {
    const data = request.data as Record<string, unknown>
    const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))

    const [groupsSnap, participantsSnap, progress] = await Promise.all([
      groupsRef(gameInstanceId).get(),
      participantsRef(gameInstanceId).get(),
      opts.progressOf(gameInstanceId),
    ])

    const numberById = groupNumbering(groupsSnap.docs.map((d) => d.id))
    const meta = new Map<string, { name: string; isBot: boolean; groupId: string | null; lastLoginMs: number | null }>()
    for (const p of participantsSnap.docs) {
      const d = p.data() as Record<string, unknown>
      meta.set(p.id, {
        name: displayNameOf(d, p.id),
        isBot: d['is_bot'] === true,
        groupId: (d['group_id'] as string | undefined) ?? null,
        lastLoginMs: toMs(d['last_login_at']),
      })
    }

    // ── §2.1.1 item B ────────────────────────────────────────────────────────
    // Nothing in the shared machinery WRITES arrived[]; the game does. So a game
    // that forgets produces a report showing everyone as never-arrived, which reads
    // as data — a finding about the class — rather than as the bug it is. Nobody
    // investigates a finding.
    //
    // So the report distinguishes them: if NO group carries an `arrived` field at
    // all, arrival data is MISSING, and every student's `arrived` is null rather
    // than false. Absence of the field, not emptiness of the set: a game that writes
    // `arrived: []` and genuinely had nobody turn up reports false, correctly.
    let arrivalDataPresent = false
    const arrivedByGroup = new Map<string, Set<string>>()
    const flagByGroup = new Map<string, { stale: boolean; reporterName: string | null }>()
    const botsByGroup = new Map<string, boolean>()

    const groups = groupsSnap.docs.map((gdoc) => {
      const doc = gdoc.data() as GroupDoc
      const g = toSeatGroup(adapter, gdoc.id, doc)
      const flag = doc['flag'] as Record<string, unknown> | undefined
      const started = adapter.hasStarted(doc)
      const prog = progress.get(gdoc.id) ?? { category: 'never_started' as const, rounds: 0 }

      if (Object.prototype.hasOwnProperty.call(doc, 'arrived')) arrivalDataPresent = true
      arrivedByGroup.set(gdoc.id, new Set((doc['arrived'] as string[] | undefined) ?? []))
      if (flag) {
        flagByGroup.set(gdoc.id, { stale: started, reporterName: (flag['reporter_name'] as string) ?? null })
      }
      const bots = g.occupants.filter((o) => o.isBot)
      botsByGroup.set(gdoc.id, bots.length > 0)

      return {
        groupId: gdoc.id,
        groupNumber: numberById.get(gdoc.id) ?? 0,
        category: prog.category,
        humanCount: g.occupants.length - bots.length,
        botCount: bots.length,
        flagged: !!flag,
        // A flag goes STALE the moment the group starts — no cleanup by anyone.
        flagStale: !!flag && started,
        reporterName: flag ? ((flag['reporter_name'] as string) ?? null) : null,
        rounds: prog.rounds,
      }
    }).sort((a, b) => a.groupNumber - b.groupNumber)

    const absences = new Map<string, number>()
    for (const [, p] of progress) {
      for (const [pid, n] of Object.entries(p.absencesByParticipant ?? {})) {
        absences.set(pid, (absences.get(pid) ?? 0) + n)
      }
    }

    // One row per HUMAN. Bots are never graded or emailed, so they are excluded here
    // exactly as they are in every other report.
    const students = participantsSnap.docs
      .filter((p) => (p.data() as Record<string, unknown>)['is_bot'] !== true)
      .map((p) => {
        const m = meta.get(p.id)!
        const gid = m.groupId
        const prog = gid ? progress.get(gid) : undefined
        return {
          participantId: p.id,
          name: m.name,
          groupNumber: gid ? (numberById.get(gid) ?? null) : null,
          category: (gid ? (prog?.category ?? 'never_started') : 'no_group') as GroupCategory | 'no_group',
          // null = we cannot say; false = we can, and they did not.
          arrived: arrivalDataPresent ? (gid ? (arrivedByGroup.get(gid)?.has(p.id) ?? false) : false) : null,
          lastLoginMs: m.lastLoginMs,
          flagged: gid ? flagByGroup.has(gid) : false,
          playedWithBots: gid ? (botsByGroup.get(gid) ?? false) : false,
          absences: absences.get(p.id) ?? 0,
          rounds: gid ? (prog?.rounds ?? 0) : null,
        }
      })
      .sort((a, b) => (a.groupNumber ?? Infinity) - (b.groupNumber ?? Infinity) || a.name.localeCompare(b.name))

    return {
      ok: true as const,
      absence_label: opts.absenceLabel ?? 'Missed',
      /**
       * FALSE means this game is not writing arrived[] — a wiring bug, not a class
       * with poor attendance. The UI must say so rather than rendering "no" for
       * everyone.
       */
      arrival_data_present: arrivalDataPresent,
      counts: {
        finished: groups.filter((g) => g.category === 'finished').length,
        inProgress: groups.filter((g) => g.category === 'in_progress').length,
        neverStarted: groups.filter((g) => g.category === 'never_started').length,
        flagged: groups.filter((g) => g.flagged && !g.flagStale).length,
      },
      groups,
      students,
    }
  })
}

const toMs = (v: unknown): number | null => {
  // Duck-typed: admin.firestore.Timestamp is not a runtime value in this module.
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    return (v as { toMillis: () => number }).toMillis()
  }
  return null
}
