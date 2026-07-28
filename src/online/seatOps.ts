// ═══════════════════════════════════════════════════════════════════════════════
// SEAT OPERATIONS — PURE. No Firestore, no auth, no I/O.
//
// This is where the invariants live, which is why it is pure: the operations that
// corrupt data if they are wrong are exactly the ones that must be testable without
// an emulator. The callables above are thin transactional shells (the Crisis pattern:
// pure machine + shell).
//
// ── THE INVARIANTS, stated once ────────────────────────────────────────────────
//   1. A participant is never in two groups.
//   2. A participant is never LOST. "Ungrouped" is a state, not an absence — an
//      ungrouped human is in the No Group pool and can always be placed again.
//   3. Ungroup leaves the group STANDING with a free seat. An emptied group costs
//      nothing and keeps its flag record intact (Online_Matching_Spec §4.4).
//   4. A human moving into a full group evicts a BOT. A bot never evicts a human,
//      and a full all-human group is genuinely full.
//   5. Locks are PER GROUP. A started group is frozen for moves in AND out; every
//      other group is unaffected.
//
// ── LOCK SCOPE (Crisis O2.1/O2.2, preserved through promotion) ─────────────────
// Instance-wide locks apply ONLY to re-group and the mode switch. Move, ungroup,
// fill and swap are per-group. The instructor rearranges not-started groups while
// other groups are mid-game — that is the whole point of the per-group rule.
// ═══════════════════════════════════════════════════════════════════════════════

import type {
  FillOutcome, MoveOutcome, SeatGroup, SeatOccupant, SeatOpRejection,
} from './types'

const reject = (reason: string): SeatOpRejection => ({ ok: false, reason })

const isHuman = (o: SeatOccupant) => !o.isBot
const humansOf = (g: SeatGroup) => g.occupants.filter(isHuman)
const botsOf = (g: SeatGroup) => g.occupants.filter((o) => o.isBot)

/** The first human in seat order, or null. A bot never leads. */
export function leadOf(group: SeatGroup): string | null {
  return humansOf(group)[0]?.participantId ?? null
}

export function isFull(group: SeatGroup, seatCount: number): boolean {
  return group.occupants.length >= seatCount
}

export function freeSeats(group: SeatGroup, seatCount: number): number {
  return Math.max(0, seatCount - group.occupants.length)
}

/**
 * Can a human be placed into this group at all? True when it is not started AND
 * either has a free seat or holds a bot that can be displaced.
 *
 * ⚠ This is a PER-GROUP predicate on purpose. The O2.1 bug the audit recorded was a
 * control gated on "a free seat exists SOMEWHERE", which is true in short-group seed
 * data and false for a real full class — so every control rendered as an empty span.
 * Availability of a destination is never a reason to hide a group's own controls.
 */
export function canAcceptHuman(group: SeatGroup, seatCount: number): boolean {
  if (group.started) return false
  return !isFull(group, seatCount) || botsOf(group).length > 0
}

/**
 * Move a human into `target`, or out of any group when `target` is null (ungroup).
 *
 * `source` is optional: a participant from the No Group pool has none, and placing
 * them is the same operation with nothing to remove them from.
 */
export function moveOccupant(input: {
  participantId: string
  source: SeatGroup | null
  target: SeatGroup | null
  seatCount: number
  /** The moving participant, when they are not already in `source` (No Group pool). */
  occupant?: SeatOccupant
}): MoveOutcome {
  const { participantId, source, target, seatCount } = input

  // Nothing to do, and nothing needed to know it: ungrouping someone who has no
  // group is already the requested state. Checked BEFORE the occupant lookup, since
  // a pool member has no source group to be found in.
  if (!target && !source) {
    return { ok: true, source: null, target: null, evictedBot: null, noop: true }
  }

  const existing = source?.occupants.find((o) => o.participantId === participantId)
  const occupant = existing ?? input.occupant
  if (!occupant) return reject('Participant not found in the source group.')
  if (occupant.isBot) return reject('Only human participants can be moved.')

  // Already where they are being sent — a no-op, not an error (idempotent retry).
  if (target && source && source.groupId === target.groupId) {
    return { ok: true, source, target, evictedBot: null, noop: true }
  }

  // ── per-group locks, both ends ──
  if (source?.started) {
    return reject('The source group has already started playing (seats are locked).')
  }
  if (target?.started) {
    return reject('The destination group has already started playing (seats are locked).')
  }

  // ── make room in the destination, evicting a BOT and never a human ──
  let evictedBot: string | null = null
  let targetOccupants = target ? [...target.occupants] : []
  if (target && targetOccupants.length >= seatCount) {
    const bots = targetOccupants.filter((o) => o.isBot)
    const displaced = bots[bots.length - 1] // the last-added bot
    if (!displaced) {
      return reject(`The destination group is already full (${seatCount} human seats).`)
    }
    evictedBot = displaced.participantId
    targetOccupants = targetOccupants.filter((o) => o.participantId !== evictedBot)
  }

  const newSource: SeatGroup | null = source
    ? { ...source, occupants: source.occupants.filter((o) => o.participantId !== participantId) }
    : null
  const newTarget: SeatGroup | null = target
    ? { ...target, occupants: [...targetOccupants, occupant] }
    : null

  return { ok: true, source: newSource, target: newTarget, evictedBot, noop: false }
}

/** Ungroup: the same operation with no destination. The group stays standing. */
export function ungroupOccupant(input: {
  participantId: string
  source: SeatGroup | null
  seatCount: number
}): MoveOutcome {
  return moveOccupant({ ...input, target: null })
}

/**
 * Fill a group's empty seats with bots. Bots take the TRAILING seats, so a later
 * human-replaces-bot eviction takes the last-added one and human seat order is
 * never disturbed.
 */
export function fillWithBots(input: {
  group: SeatGroup
  seatCount: number
  /** Mints one bot occupant; index is 1-based among this group's bots. */
  mint: (index: number) => SeatOccupant
}): FillOutcome {
  const { group, seatCount, mint } = input
  if (group.started) {
    return reject('This group has already started playing (seats are locked).')
  }
  const needed = freeSeats(group, seatCount)
  if (needed === 0) return { ok: true, group, added: [] }

  const startIndex = botsOf(group).length
  const added: SeatOccupant[] = []
  for (let i = 0; i < needed; i++) added.push(mint(startIndex + i + 1))

  return { ok: true, group: { ...group, occupants: [...group.occupants, ...added] }, added }
}

/**
 * Chunk a shuffled roster into groups of `seatCount`. The remainder forms ONE final
 * short group — never discarded, never an oversized group. Bot-fill is a separate,
 * instructor-triggered step (Online_Matching_Spec §4.5: released by Elena, not
 * automatic, because the escalation email usually works and immediate bot-fill
 * undermines it).
 */
export function chunkIntoGroups<T>(items: readonly T[], seatCount: number): T[][] {
  if (seatCount < 1) throw new Error('[game-server] seatCount must be >= 1.')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += seatCount) out.push(items.slice(i, i + seatCount))
  return out
}

// ── invariant checking (used by the tests, exported so a consumer can assert too) ──

export interface SeatingPlan {
  groups: SeatGroup[]
  /** Humans with no group — the No Group pool. Ungrouped is a STATE. */
  unassigned: SeatOccupant[]
}

export interface InvariantViolation {
  invariant: string
  detail: string
}

/**
 * Check the seating invariants over a whole plan. Returns every violation rather
 * than the first, so a failing test names all of what broke.
 */
export function checkSeatingInvariants(plan: SeatingPlan, seatCount: number): InvariantViolation[] {
  const out: InvariantViolation[] = []
  const seen = new Map<string, string[]>()

  for (const g of plan.groups) {
    for (const o of g.occupants) {
      seen.set(o.participantId, [...(seen.get(o.participantId) ?? []), g.groupId])
    }
    if (g.occupants.length > seatCount) {
      out.push({
        invariant: 'group never exceeds seatCount',
        detail: `${g.groupId} holds ${g.occupants.length} of ${seatCount}`,
      })
    }
    const ids = g.occupants.map((o) => o.participantId)
    if (new Set(ids).size !== ids.length) {
      out.push({ invariant: 'no duplicate seat in a group', detail: g.groupId })
    }
  }

  for (const [pid, groups] of seen) {
    if (groups.length > 1) {
      out.push({
        invariant: 'a participant is never in two groups',
        detail: `${pid} is in ${groups.join(' and ')}`,
      })
    }
  }

  for (const u of plan.unassigned) {
    if (seen.has(u.participantId)) {
      out.push({
        invariant: 'a participant is never both grouped and unassigned',
        detail: u.participantId,
      })
    }
    if (u.isBot) {
      out.push({
        invariant: 'a bot is never in the No Group pool',
        detail: `${u.participantId} — bots are seat-fillers, not people`,
      })
    }
  }

  return out
}

/** Every human known to a plan, grouped or not — the "never lost" population. */
export function populationOf(plan: SeatingPlan): string[] {
  const ids = [
    ...plan.groups.flatMap((g) => g.occupants.filter(isHuman).map((o) => o.participantId)),
    ...plan.unassigned.map((o) => o.participantId),
  ]
  return [...ids].sort()
}
