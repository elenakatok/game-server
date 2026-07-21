// Shared latecomer joinability predicate for the negotiation games
// (Latecomer_Placement_Spec_v1 §3.1). ONE predicate for all five — winemaster,
// hawks, vivo, claridge, adirondacks — because they share the group-status
// lifecycle: makeTriggerMatching writes 'matched', makeStartNegotiation writes
// 'negotiating'. A group is joinable ONLY while freshly matched, i.e. before
// anyone has started negotiating.
//
// General → shared package, never a per-game copy. No onPlace: negotiation
// placement is group_id only, so nothing beyond the shared placement runs.

import type { DocumentData } from 'firebase-admin/firestore'
import type { JoinableContext } from './placementTypes'

/**
 * Joinable ⇔ the group has not started negotiating (§3.1). 'matched' is the only
 * pre-negotiation status; once 'negotiating' (or reporting/deadlocked/completed)
 * the group is closed to latecomers. Synchronous — the signal is on the group
 * doc, unlike eBay's RTDB clock. No size cap (§3.2), so participantCount is unused.
 */
export function negotiationIsJoinable(group: DocumentData, _ctx: JoinableContext): boolean {
  return group['status'] === 'matched'
}
