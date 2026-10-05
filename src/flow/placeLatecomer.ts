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

import { randomUUID } from 'crypto'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { roleKeys, fieldFor } from '@mygames/game-engine'
import type { GameDefinition } from '../GameDefinition'
import { selectPlacementGroup, selectSpareSplit, type PlacementCandidate } from './placement'

/** What placeLatecomer needs from a GameDefinition. */
type PlacementDef = Pick<GameDefinition, 'roles' | 'isJoinable' | 'onPlace'> &
  Partial<Pick<GameDefinition, 'composition' | 'latecomerPairsWithSpare'>>

/** The chosen group's document data, or absent when no group is joinable. */
export type PlaceLatecomerResult =
  | { placed: admin.firestore.DocumentData; formedNewGroup?: true }
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
    // ── READS (all Firestore reads before any write — Firestore rule) ──────
    const [pSnap, groupsSnap] = await Promise.all([tx.get(participantRef), tx.get(groupsRef)])
    if (!pSnap.exists) throw new Error(`placeLatecomer: participant ${participantId} not found`)
    const role = pSnap.data()!['role'] as string

    const infos = groupsSnap.docs.map((d) => {
      const data = d.data()
      const size = roleFields.reduce(
        (n, f) => n + ((data[f] as string[] | undefined)?.length ?? 0),
        0,
      )
      return { ref: d.ref, data, size }
    })

    // isJoinable may be async (e.g. eBay reads the RTDB auction clock), so evaluate
    // every group's predicate here, in the read phase, BEFORE any write. This keeps
    // the selector itself pure — it receives resolved booleans.
    const joinableFlags = await Promise.all(
      infos.map((g) =>
        def.isJoinable
          ? Promise.resolve(def.isJoinable(g.data, { gameInstanceId, participantCount: g.size }))
          : Promise.resolve(false),
      ),
    )
    const candidates: GroupCandidate[] = infos.map((g, i) => ({ ...g, joinable: joinableFlags[i] }))

    // ── SPARE SPLIT (opt-in) ───────────────────────────────────────────────
    // Before adding the latecomer to an existing group, try to make a NEW complete
    // group from them plus spares held by joinable groups (see GameDefinition
    // .latecomerPairsWithSpare). All reads are already done; this only writes.
    if (def.latecomerPairsWithSpare && def.composition) {
      const keys = roleKeys(def.roles)
      const joinableCands = candidates.filter((c) => c.joinable)
      const picks = selectSpareSplit(
        joinableCands.map((c) => ({
          groupId: c.ref.id,
          leadId: (c.data['lead_participant_id'] as string | undefined) ?? null,
          membersByRole: Object.fromEntries(
            keys.map((k) => [k, (c.data[fieldFor(k, 'participants')] as string[] | undefined) ?? []]),
          ),
        })),
        keys,
        def.composition,
        role,
      )
      if (picks) {
        const groupId = randomUUID()
        const newRef = groupsRef.doc(groupId)
        const membersByRole: Record<string, string[]> = Object.fromEntries(keys.map((k) => [k, [] as string[]]))
        for (const pk of picks) membersByRole[pk.role].push(pk.participantId)
        membersByRole[role].push(participantId)
        // Lead: first member of the first declared role present — matching's rule.
        const leadRole = keys.find((k) => membersByRole[k].length > 0)!
        const lead = membersByRole[leadRole][0]
        const groupDoc = {
          group_id: groupId,
          game_instance_id: gameInstanceId,
          lead_participant_id: lead,
          outcome: null,
          ...Object.fromEntries(keys.map((k) => [fieldFor(k, 'participants'), membersByRole[k]])),
          status: 'matched',
          matched_at: FieldValue.serverTimestamp(),
        }
        tx.set(newRef, groupDoc)
        for (const pk of picks) {
          tx.update(groupsRef.doc(pk.groupId), {
            [fieldFor(pk.role, 'participants')]: FieldValue.arrayRemove(pk.participantId),
          })
          tx.update(instanceRef.collection('participants').doc(pk.participantId), {
            group_id: groupId,
            is_lead: pk.participantId === lead,
          })
        }
        tx.update(participantRef, { group_id: groupId, is_lead: participantId === lead })
        return { placed: groupDoc, formedNewGroup: true as const }
      }
    }

    // ── SELECT (pure) ──────────────────────────────────────────────────────
    const forSelect: PlacementCandidate<GroupCandidate>[] = candidates.map((c) => ({
      group: c,
      size: c.size,
      joinable: c.joinable,
    }))
    const result = selectPlacementGroup(forSelect, rng)
    if ('absent' in result) return { absent: true as const }

    const chosen = result.placed

    // onPlace runs HERE — still before the placement's own writes — so it may do
    // its own tx reads (fresh, retry-safe) THEN writes, all within the one atomic
    // transaction. A latecomer thus ends up in EXACTLY the state matching would
    // have produced (spec §Part A). onPlace sees the pre-placement group snapshot
    // (`chosen.data`), which is what it needs (e.g. eBay's next bidder slot).
    if (def.onPlace) {
      await def.onPlace(
        chosen.data,
        { participant_id: participantId, role },
        { gameInstanceId, db, tx, groupRef: chosen.ref, participantRef },
      )
    }

    // ── PLACEMENT WRITES ───────────────────────────────────────────────────
    tx.update(participantRef, { group_id: chosen.data['group_id'], is_lead: false })
    // arrayUnion keeps a concurrent placement into the same group from clobbering
    // the other's membership; also idempotent on a transaction retry.
    tx.update(chosen.ref, { [fieldFor(role, 'participants')]: FieldValue.arrayUnion(participantId) })

    return { placed: chosen.data }
  })
}
