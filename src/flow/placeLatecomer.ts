// Latecomer placement — the shared transactional wrapper (Latecomer_Placement_Spec
// _v1 §3). Reads the instance's groups, runs the pure selector, and — atomically —
// stamps the latecomer into the chosen group, then runs the game's onPlace hook.
//
// NOT wired to any call site in this step. A later step calls this from the
// code-entry path once matching has already run.
//
// Concurrency (spec §3.4): two simultaneous latecomers MAY land in the same
// group — that is allowed. This does not serialize on group size. Atomicity is
// what matters: each placement runs in one transaction, membership is added with
// arrayUnion (never a read-modify-write that could drop the other), and each
// participant doc is written once, so no write is lost and no participant ends
// up in two groups or none. On contention Firestore retries the loser, which
// re-reads and re-selects against the winner's committed state.

import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { roleKeys, fieldFor } from '@mygames/game-engine'
import type { GameDefinition } from '../GameDefinition'
import { selectPlacementGroup, type PlacementCandidate } from './placement'

/** What placeLatecomer needs from a GameDefinition. */
type PlacementDef = Pick<GameDefinition, 'roles' | 'isJoinable' | 'onPlace'>

/** The chosen group's document data, or absent when no group is joinable. */
export type PlaceLatecomerResult =
  | { placed: admin.firestore.DocumentData }
  | { absent: true }

interface GroupCandidate {
  ref: admin.firestore.DocumentReference
  data: admin.firestore.DocumentData
  size: number
  joinable: boolean
}

/**
 * Place a latecomer into the smallest joinable group of an already-matched
 * instance (spec §3). Returns the chosen group on success, or `{ absent: true }`
 * when nothing is joinable — writing NOTHING in the absent case, so the caller
 * owns the absent/no_show decision and message.
 *
 * @param def   the game definition (roles + optional isJoinable/onPlace hooks)
 * @param db    admin Firestore
 * @param gameInstanceId  the instance whose groups to place into
 * @param participantId   the latecomer (must already exist, with a role)
 * @param rng   tie-break RNG (injected for tests; defaults to Math.random)
 */
export async function placeLatecomer(
  def: PlacementDef,
  db: admin.firestore.Firestore,
  gameInstanceId: string,
  participantId: string,
  rng: () => number = Math.random,
): Promise<PlaceLatecomerResult> {
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const participantRef = instanceRef.collection('participants').doc(participantId)
  const groupsRef = instanceRef.collection('groups')
  const roleFields = roleKeys(def.roles).map((k) => fieldFor(k, 'participants'))

  return db.runTransaction(async (tx) => {
    // ── READS (all before any write — Firestore rule) ──────────────────────
    const [pSnap, groupsSnap] = await Promise.all([tx.get(participantRef), tx.get(groupsRef)])
    if (!pSnap.exists) throw new Error(`placeLatecomer: participant ${participantId} not found`)
    const role = pSnap.data()!['role'] as string

    const candidates: GroupCandidate[] = groupsSnap.docs.map((d) => {
      const data = d.data()
      const size = roleFields.reduce(
        (n, f) => n + ((data[f] as string[] | undefined)?.length ?? 0),
        0,
      )
      const joinable = def.isJoinable
        ? def.isJoinable(data, { gameInstanceId, participantCount: size })
        : false
      return { ref: d.ref, data, size, joinable }
    })

    // ── SELECT (pure) ──────────────────────────────────────────────────────
    const forSelect: PlacementCandidate<GroupCandidate>[] = candidates.map((c) => ({
      group: c,
      size: c.size,
      joinable: c.joinable,
    }))
    const result = selectPlacementGroup(forSelect, rng)
    if ('absent' in result) return { absent: true as const }

    const chosen = result.placed

    // ── WRITES (placement only; onPlace may add more) ──────────────────────
    tx.update(participantRef, { group_id: chosen.data['group_id'], is_lead: false })
    // arrayUnion keeps a concurrent placement into the same group from clobbering
    // the other's membership; also idempotent on a transaction retry.
    tx.update(chosen.ref, { [fieldFor(role, 'participants')]: FieldValue.arrayUnion(participantId) })

    if (def.onPlace) {
      await def.onPlace(
        chosen.data,
        { participant_id: participantId, role },
        { gameInstanceId, db, tx, groupRef: chosen.ref, participantRef },
      )
    }

    return { placed: chosen.data }
  })
}
