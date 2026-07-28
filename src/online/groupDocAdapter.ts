// ═══════════════════════════════════════════════════════════════════════════════
// THE GROUP-DOC ADAPTER (Extraction Spec §2.1).
//
// The seat machinery reasons about OCCUPANTS. The two families store occupants
// differently, and the "has this group started" flag is named differently per game:
//
//   stage       player_participants[]  + bot_participants[]      started: seats_locked_at
//   negotiation <role>_participants[]  (one array per role)      started: negotiation_started_at
//
// A small per-family SHAPE MAPPING — not a fork, and deliberately not a union type
// that grows a branch per game. The shared callable works against the adapter; each
// family supplies one. Adding a family is adding an adapter, and touches nothing
// that already works.
//
// ⚠ ONLY THE STAGE ADAPTER IS WIRED UP IN THIS SLICE. The negotiation adapter is
// defined and unit-tested, but has no consumer until the six-game rollout in late
// September (Instructor_Move_Ungroup_Shared_Spec §4.3).
//
// ── WHY THE TWO SHAPES RECONCILE ──────────────────────────────────────────────
// They reconcile because the seat machinery never needs to know WHICH array an
// occupant lives in — only who occupies a seat and whether the group has started.
// Reading is a flatten; writing is a partition by role. The negotiation family's
// extra bookkeeping (lead_outcome, lead_reported_at, confirmations, reset_count,
// completed_at, outcomes_by_round) is untouched by every seat operation, so it never
// has to appear in this interface at all. The one field both families genuinely
// share — lead_participant_id — is recomputed identically by both.
// ═══════════════════════════════════════════════════════════════════════════════

import type { SeatGroup, SeatOccupant } from './types'

export type GroupDoc = Record<string, unknown>

export interface WriteMembershipInput {
  /** The group's current stored document; null for a brand-new group. */
  existing: GroupDoc | null
  /** The new seat contents, in seat order. */
  occupants: SeatOccupant[]
  /** The new lead (first human in seat order), or null for an all-bot/empty group. */
  lead: string | null
}

export interface NewGroupInput extends WriteMembershipInput {
  groupId: string
  gameInstanceId: string
  /** Opaque server timestamp value, supplied by the caller. */
  now: unknown
}

export interface GroupDocAdapter {
  family: 'stage' | 'negotiation'
  /** Human-readable name of the per-group lock field, for error messages. */
  startedField: string
  /** Seat contents, in seat order. */
  readOccupants: (group: GroupDoc) => SeatOccupant[]
  /** The per-group lock: has this group started playing? */
  hasStarted: (group: GroupDoc) => boolean
  /** Firestore patch recording a new membership. Never touches unrelated fields. */
  writeMembership: (input: WriteMembershipInput) => GroupDoc
  /** The full document for a brand-new group. */
  newGroupFields: (input: NewGroupInput) => GroupDoc
}

const strArray = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])

// ── stage family ───────────────────────────────────────────────────────────────

/**
 * `player_participants` is the seat list (humans AND bots, in seat order);
 * `bot_participants` marks which of those are bots. `members[]` / `member_logins`
 * are the denormalised reveal data, maintained ONLY when the group already carries
 * them — an online-formed group has them, a classroom-matched group does not, and
 * fabricating them on a classroom group would break the very gate the reveal uses.
 */
export function makeStageGroupAdapter(): GroupDocAdapter {
  return {
    family: 'stage',
    startedField: 'seats_locked_at',

    readOccupants: (group) => {
      const seats = strArray(group['player_participants'])
      const bots = new Set(strArray(group['bot_participants']))
      const members = Array.isArray(group['members'])
        ? (group['members'] as { participant_id?: string; display_name?: string; email?: string | null }[])
        : []
      const byId = new Map(members.filter((m) => m?.participant_id).map((m) => [m.participant_id as string, m]))
      const logins = (group['member_logins'] ?? {}) as Record<string, unknown>
      return seats.map((pid) => {
        const m = byId.get(pid)
        const o: SeatOccupant = { participantId: pid, isBot: bots.has(pid), role: null }
        if (m?.display_name !== undefined) o.displayName = m.display_name
        if (m?.email !== undefined) o.email = m.email
        if (logins[pid] !== undefined) o.lastLoginAt = logins[pid]
        return o
      })
    },

    hasStarted: (group) => group['seats_locked_at'] != null,

    writeMembership: ({ existing, occupants, lead }) => {
      const bots = occupants.filter((o) => o.isBot)
      const patch: GroupDoc = {
        player_participants: occupants.map((o) => o.participantId),
        bot_participants: bots.map((o) => o.participantId),
        bot_count: bots.length,
        lead_participant_id: lead,
      }
      // members[]/member_logins are maintained only where they already exist.
      if (Array.isArray(existing?.['members'])) Object.assign(patch, denormalised(occupants))
      return patch
    },

    newGroupFields: ({ groupId, gameInstanceId, occupants, lead, now }) => {
      const bots = occupants.filter((o) => o.isBot)
      return {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        player_participants: occupants.map((o) => o.participantId),
        bot_participants: bots.map((o) => o.participantId),
        bot_count: bots.length,
        lead_participant_id: lead,
        ...denormalised(occupants),
        /**
         * INITIALISED EMPTY, and that is load-bearing.
         *
         * `makeGetOnlineReport` decides `arrival_data_present` by the PRESENCE of
         * this field, so that a game which is wired but whose students have not
         * turned up yet still reports real data (everyone `arrived: false`) rather
         * than "not recorded".
         *
         * If the field only appeared on the first arrival — via arrayUnion, which is
         * how it is written — then a freshly pre-grouped instance would have no key
         * at all. That is the NORMAL state of an online assignment, since the whole
         * point is that students arrive later, and the report would wrongly announce
         * that the game is not writing arrivals. Presence-of-field cannot distinguish
         * "not wired" from "wired, nobody yet" unless creation writes it.
         */
        arrived: [],
        outcome: null,
        status: 'matched',
        matched_at: now,
      }
    },
  }
}

/** The reveal's denormalised human list: name + email, humans only. */
function denormalised(occupants: SeatOccupant[]): GroupDoc {
  const humans = occupants.filter((o) => !o.isBot)
  const member_logins: Record<string, unknown> = {}
  for (const h of humans) if (h.lastLoginAt != null) member_logins[h.participantId] = h.lastLoginAt
  return {
    members: humans.map((h) => ({
      participant_id: h.participantId,
      display_name: h.displayName ?? h.participantId,
      email: h.email ?? null,
    })),
    member_logins,
  }
}

// ── negotiation family (DEFINED, no consumer until late September) ─────────────

/**
 * Occupants live in one array per role. `roleKeys` comes from the game definition,
 * and an occupant's `role` decides which array it is written to — which is why
 * SeatOccupant carries `role` at all.
 *
 * `started` is the negotiation lifecycle rather than a seat lock: a group that has
 * begun negotiating is frozen for moves in and out, exactly as the stage family's
 * `seats_locked_at` freezes a group that has begun playing. Same rule, different
 * field name — which is the entire reason this adapter exists.
 *
 * Bots do not exist in this family: `readOccupants` reports every occupant as human,
 * and bot-fill is simply never offered for a negotiation game.
 */
export function makeNegotiationGroupAdapter(roleKeys: readonly string[]): GroupDocAdapter {
  const field = (role: string) => `${role}_participants`
  return {
    family: 'negotiation',
    startedField: 'negotiation_started_at',

    readOccupants: (group) =>
      roleKeys.flatMap((role) =>
        strArray(group[field(role)]).map((pid): SeatOccupant => ({
          participantId: pid,
          isBot: false,
          role,
        })),
      ),

    hasStarted: (group) =>
      group['negotiation_started_at'] != null || group['status'] === 'negotiating',

    writeMembership: ({ occupants, lead }) => {
      const patch: GroupDoc = { lead_participant_id: lead }
      // Every declared role array is written, including the ones that became empty —
      // a role emptied by a move must not keep its old occupant.
      for (const role of roleKeys) {
        patch[field(role)] = occupants.filter((o) => o.role === role).map((o) => o.participantId)
      }
      return patch
    },

    newGroupFields: ({ groupId, gameInstanceId, occupants, lead, now }) => {
      const patch: GroupDoc = {
        group_id: groupId,
        game_instance_id: gameInstanceId,
        lead_participant_id: lead,
        outcome: null,
        status: 'matched',
        matched_at: now,
      }
      for (const role of roleKeys) {
        patch[field(role)] = occupants.filter((o) => o.role === role).map((o) => o.participantId)
      }
      return patch
    },
  }
}

// ── shared helper ──────────────────────────────────────────────────────────────

/** Read a stored group document into the seat machinery's shape. */
export function toSeatGroup(adapter: GroupDocAdapter, groupId: string, doc: GroupDoc): SeatGroup {
  return {
    groupId,
    occupants: adapter.readOccupants(doc),
    started: adapter.hasStarted(doc),
  }
}
