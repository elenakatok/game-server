// ═══════════════════════════════════════════════════════════════════════════════
// ONLINE / SEAT-MANAGEMENT machinery — shared types.
//
// Promoted from Crisis (Slice 0 audit §E) per Extraction Spec §2.1. ADDITIVE ONLY:
// nothing here changes any existing export. No game consumes it yet — Crisis keeps
// running entirely on its own code until Slice 5.
//
// The three things Crisis hard-coded and this does not:
//   • seat count — a parameter (`seatCount`), so n=2 (Info Sharing), n=3 (Crisis)
//     and n=7 (SAA) all work
//   • role names / bid bounds / game copy — none of it appears here
//   • group-doc field names — behind a GroupDocAdapter (see groupDocAdapter.ts)
// ═══════════════════════════════════════════════════════════════════════════════

/** One occupant of a seat. `role` is null for the stage family (roles assigned late). */
export interface SeatOccupant {
  participantId: string
  isBot: boolean
  /** Negotiation family only — the role whose array this participant belongs in. */
  role?: string | null
  displayName?: string
  email?: string | null
  /** Opaque timestamp value, carried through untouched. */
  lastLoginAt?: unknown
}

/** A group as the seat machinery sees it, independent of its stored field names. */
export interface SeatGroup {
  groupId: string
  /** Seat order. Humans and bots together — a bot occupies a real seat. */
  occupants: SeatOccupant[]
  /** Per-group lock: this group has started playing and its seats are frozen. */
  started: boolean
}

/**
 * A game's online/seat-management declaration. Everything Crisis hard-coded that a
 * different game would need to change.
 */
export interface OnlineDefinition {
  /** Seats per group. Crisis 3, Info Sharing 2, SAA 7. */
  seatCount: number
  /**
   * Build a bot seat's participant document. The GAME owns this: Crisis's bots carry
   * a Seller `bot_type`, Info Sharing's will carry something else, and the shared
   * machinery must never invent one.
   */
  makeBotSeat: (ctx: MakeBotSeatContext) => { participantId: string; doc: Record<string, unknown> }
  /**
   * Extra group-doc fields to write when bots are added or removed, e.g. Crisis's
   * `bot_types` map. Optional; omit for a game whose bots need no group-level record.
   */
  botGroupFields?: (bots: SeatOccupant[], existing: Record<string, unknown>) => Record<string, unknown>
  /** Subject line for the "I can't reach my group" mailto. Game copy, never shared. */
  flagMailSubject?: string
}

export interface MakeBotSeatContext {
  gameInstanceId: string
  groupId: string
  /** 1-based index among this group's bots — for a stable, readable id. */
  index: number
}

// ── operation results ──────────────────────────────────────────────────────────

export type SeatOpRejection = { ok: false; reason: string }

export interface MoveResult {
  ok: true
  /** The source group after the move — null when the participant had no group. */
  source: SeatGroup | null
  /** The destination after the move — null for an ungroup. */
  target: SeatGroup | null
  /** A bot displaced to make room for a human, if any. */
  evictedBot: string | null
  /** True when nothing needed to change (already in the destination). */
  noop: boolean
}

export interface FillResult {
  ok: true
  group: SeatGroup
  /** Bots added, in seat order. Empty when the group was already full. */
  added: SeatOccupant[]
}

export type MoveOutcome = MoveResult | SeatOpRejection
export type FillOutcome = FillResult | SeatOpRejection
