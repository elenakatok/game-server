// Emulator integration tests for placeLatecomer (Latecomer_Placement_Spec_v1 §3).
// Gated on FIRESTORE_EMULATOR_HOST, so a plain `vitest run` skips them; run with:
//
//   firebase emulators:exec --only firestore --project demo-latecomer \
//     "npx vitest run test/flow/placeLatecomer.emu.test.ts"
//
// Covers: onPlace runs once for a placed latecomer (7); placement succeeds with
// no onPlace (8); two concurrent placements — both placed, no write lost, no one
// in two groups (9); and the absent path writes nothing.

import { describe, it, expect, beforeAll } from 'vitest'
import * as admin from 'firebase-admin'
import { placeLatecomer } from '../../src/flow/placeLatecomer'
import type { GameDefinition } from '../../src/GameDefinition'

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST
const d = EMU ? describe : describe.skip

type PlacementDef = Pick<GameDefinition, 'roles' | 'isJoinable' | 'onPlace'>
const roles: GameDefinition['roles'] = { roles: [{ key: 'trader', label: 'Trader', short: 'T' }] }

let db: admin.firestore.Firestore
let seq = 0

beforeAll(() => {
  if (!EMU) return
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-latecomer' })
  db = admin.firestore()
})

/**
 * Seed an instance with the given groups and a set of unclaimed latecomers.
 * groups: [{ id, status, members }]. Every participant has role 'trader'.
 */
async function seed(
  groups: Array<{ id: string; status: string; members: string[] }>,
  latecomers: string[],
): Promise<string> {
  const instanceId = `ls-${Date.now().toString(36)}-${seq++}`
  const inst = db.collection('game_instances').doc(instanceId)
  const batch = db.batch()
  for (const g of groups) {
    batch.set(inst.collection('groups').doc(g.id), {
      group_id: g.id,
      status: g.status,
      trader_participants: g.members,
    })
    for (const pid of g.members) {
      batch.set(inst.collection('participants').doc(pid), { role: 'trader', group_id: g.id })
    }
  }
  for (const pid of latecomers) {
    batch.set(inst.collection('participants').doc(pid), { role: 'trader' })
  }
  await batch.commit()
  return instanceId
}

const participant = async (instanceId: string, pid: string) =>
  (await db.collection('game_instances').doc(instanceId).collection('participants').doc(pid).get()).data()
const group = async (instanceId: string, gid: string) =>
  (await db.collection('game_instances').doc(instanceId).collection('groups').doc(gid).get()).data()

// 'matched' groups are joinable; anything else is not (the negotiation predicate).
const joinableWhenMatched = (g: admin.firestore.DocumentData) => g['status'] === 'matched'

d('placeLatecomer — emulator', () => {
  it('7. onPlace runs exactly once for a placed latecomer', async () => {
    const inst = await seed([{ id: 'g1', status: 'matched', members: ['a', 'b'] }], ['late'])
    let calls = 0
    const def: PlacementDef = {
      roles,
      isJoinable: joinableWhenMatched,
      onPlace: async (_g, p, ctx) => {
        calls++
        // A stand-in for eBay's per-member signal assignment — a write via tx.
        ctx.tx.update(ctx.participantRef, { signal_assigned: true, onplace_for: p.participant_id })
      },
    }
    const res = await placeLatecomer(def, db, inst, 'late')

    expect('placed' in res).toBe(true)
    expect(calls).toBe(1)
    const p = await participant(inst, 'late')
    expect(p?.group_id).toBe('g1')
    expect(p?.is_lead).toBe(false)
    expect(p?.signal_assigned).toBe(true) // onPlace's write committed
    const g = await group(inst, 'g1')
    expect(g?.trader_participants).toEqual(['a', 'b', 'late']) // added, nothing lost
  })

  it('8. placement succeeds with no onPlace supplied', async () => {
    const inst = await seed([{ id: 'g1', status: 'matched', members: ['a', 'b'] }], ['late'])
    const def: PlacementDef = { roles, isJoinable: joinableWhenMatched } // no onPlace
    const res = await placeLatecomer(def, db, inst, 'late')

    expect(res).toMatchObject({ placed: { group_id: 'g1' } })
    const p = await participant(inst, 'late')
    expect(p?.group_id).toBe('g1')
    const g = await group(inst, 'g1')
    expect(g?.trader_participants).toContain('late')
  })

  it('8b. absent when nothing joinable → writes nothing (no onPlace, no membership)', async () => {
    const inst = await seed([{ id: 'g1', status: 'negotiating', members: ['a', 'b'] }], ['late'])
    let calls = 0
    const def: PlacementDef = {
      roles,
      isJoinable: joinableWhenMatched, // g1 is 'negotiating' → not joinable
      onPlace: async () => { calls++ },
    }
    const res = await placeLatecomer(def, db, inst, 'late')

    expect(res).toEqual({ absent: true })
    expect(calls).toBe(0)
    const p = await participant(inst, 'late')
    expect(p?.group_id).toBeUndefined() // untouched
    const g = await group(inst, 'g1')
    expect(g?.trader_participants).toEqual(['a', 'b']) // untouched
  })

  it('9. two concurrent placements → both placed, no write lost, no one in two groups', async () => {
    // One joinable group; both latecomers must land in it, and both memberships
    // must survive (arrayUnion + transaction retry), proving no lost write.
    const inst = await seed([{ id: 'g1', status: 'matched', members: ['a', 'b'] }], ['p1', 'p2'])
    const def: PlacementDef = { roles, isJoinable: joinableWhenMatched }

    const [r1, r2] = await Promise.all([
      placeLatecomer(def, db, inst, 'p1'),
      placeLatecomer(def, db, inst, 'p2'),
    ])
    expect('placed' in r1 && 'placed' in r2).toBe(true)

    const g = await group(inst, 'g1')
    const members: string[] = g?.trader_participants ?? []
    expect(members).toContain('p1')
    expect(members).toContain('p2')
    expect(new Set(members).size).toBe(members.length) // no duplicates
    expect(members.sort()).toEqual(['a', 'b', 'p1', 'p2'])

    const p1 = await participant(inst, 'p1')
    const p2 = await participant(inst, 'p2')
    expect(p1?.group_id).toBe('g1')
    expect(p2?.group_id).toBe('g1')
  })

  it('9b. concurrent placements across two joinable groups → each placed once, total membership +2', async () => {
    const inst = await seed(
      [
        { id: 'g1', status: 'matched', members: ['a', 'b'] },
        { id: 'g2', status: 'matched', members: ['c', 'd'] },
      ],
      ['p1', 'p2'],
    )
    const def: PlacementDef = { roles, isJoinable: joinableWhenMatched }

    await Promise.all([
      placeLatecomer(def, db, inst, 'p1'),
      placeLatecomer(def, db, inst, 'p2'),
    ])

    const g1 = (await group(inst, 'g1'))?.trader_participants as string[]
    const g2 = (await group(inst, 'g2'))?.trader_participants as string[]
    const all = [...g1, ...g2]
    // Each latecomer placed exactly once, somewhere, no duplication.
    expect(all.filter((x) => x === 'p1')).toHaveLength(1)
    expect(all.filter((x) => x === 'p2')).toHaveLength(1)
    expect(all).toHaveLength(6) // a,b,c,d + p1 + p2
  })
})
