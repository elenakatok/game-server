// Context types for the two latecomer-placement hooks on GameDefinition
// (Latecomer_Placement_Spec_v1 §3.1). Kept in a leaf file so GameDefinition can
// reference them without importing the placement transaction (no cycle), and so
// the firebase-admin coupling lives here rather than in GameDefinition.

import type { Firestore, Transaction, DocumentReference } from 'firebase-admin/firestore'

/**
 * Read-only context for `isJoinable`. Evaluated during selection, before any
 * write, so it carries no transaction — the predicate decides from the group
 * document plus these derived values only.
 */
export interface JoinableContext {
  gameInstanceId: string
  /** Total participants already in this group, across every role array. */
  participantCount: number
}

/** The latecomer being placed, passed to `onPlace`. */
export interface PlacementParticipant {
  participant_id: string
  /** The participant's role key (as stored on the participant doc). */
  role: string
}

/**
 * Context for `onPlace`. onPlace runs INSIDE the placement transaction, BEFORE
 * the group_id/membership writes, so it may do its own reads via `tx.get` and
 * THEN writes via `tx` — as long as all reads precede all writes (Firestore's
 * one rule). This is how a latecomer reaches EXACTLY the state matching would
 * have produced: eBay writes the bidder endowment for the next slot; Spectrum
 * reads current team cash and writes the per-member mirror.
 */
export interface PlaceContext {
  gameInstanceId: string
  db: Firestore
  tx: Transaction
  /** The chosen group's document ref. */
  groupRef: DocumentReference
  /** The latecomer's participant document ref. */
  participantRef: DocumentReference
}
