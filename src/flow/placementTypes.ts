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
 * Write context for `onPlace`. onPlace runs INSIDE the placement transaction,
 * AFTER the group_id write, so it may only WRITE via `tx` — Firestore forbids
 * reads after writes in a single transaction. A game whose per-member setup
 * needs to READ (e.g. current team cash) will get a dedicated read hook when it
 * is wired; none exists yet because no game is wired in this step.
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
