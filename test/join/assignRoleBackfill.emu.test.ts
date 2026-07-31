// Emulator tests for the role-timing back-fill in doAssignRole
// (ROLE_TIMING_BACKFILL_CHECK.md §5). Gated on FIRESTORE_EMULATOR_HOST, so a plain
// `vitest run` skips them; run with:
//
//   firebase emulators:exec --only firestore --project demo-assignrole \
//     "npx vitest run test/join/assignRoleBackfill.emu.test.ts"
//
// Covers: back-fill of a placed-then-role student into the group's <role>_participants
// array + lead-if-empty; lead preserved when already set; the match-first regression path
// (no group_id → no group write); and idempotency under a concurrent double-assign.
//
// NEGATIVE CONTROL (07-29 discipline): comment out the back-fill block in
// src/join/makeAssignRole.ts and re-run — the back-fill / lead / idempotency cases MUST go
// red while the regression case stays green. An assertion never seen to fail is not known
// to work.

import { describe, it, expect, beforeAll } from 'vitest'
import * as admin from 'firebase-admin'
import { fieldFor } from '@mygames/game-engine'
import { doAssignRole } from '../../src/join/makeAssignRole'

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST
const d = EMU ? describe : describe.skip

// A generic 2-role negotiation-shaped config. Roles are irrelevant to the mechanism;
// what matters is that seating is per-role (fieldFor(role,'participants')).
const ROLE_KEYS = ['buyer', 'seller']
const COMPOSITION = { buyer: 2, seller: 2 }

let db: admin.firestore.Firestore
let seq = 0

beforeAll(() => {
  if (!EMU) return
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-assignrole' })
  db = admin.firestore()
})

function newInstanceId() { return `ar-${Date.now().toString(36)}-${seq++}` }

async function seedParticipant(
  instanceId: string,
  participantId: string,
  fields: Record<string, unknown>,
) {
  await db.collection('game_instances').doc(instanceId)
    .collection('participants').doc(participantId).set({ participant_id: participantId, ...fields })
}

async function seedGroup(instanceId: string, groupId: string, fields: Record<string, unknown>) {
  await db.collection('game_instances').doc(instanceId)
    .collection('groups').doc(groupId).set({ group_id: groupId, status: 'matched', ...fields })
}

async function readGroup(instanceId: string, groupId: string) {
  return (await db.collection('game_instances').doc(instanceId).collection('groups').doc(groupId).get()).data() ?? {}
}
async function readParticipant(instanceId: string, participantId: string) {
  return (await db.collection('game_instances').doc(instanceId).collection('participants').doc(participantId).get()).data() ?? {}
}

d('doAssignRole — role-timing back-fill', () => {
  it('back-fills a placed-then-role student into the group role array AND sets lead if empty', async () => {
    const inst = newInstanceId()
    const gid = 'g1'
    // Group exists, has NO lead and empty role arrays (a group whose only member so far was
    // placed role-less). Participant is placed (group_id set) but role-less.
    await seedGroup(inst, gid, { lead_participant_id: null, buyer_participants: [], seller_participants: [] })
    await seedParticipant(inst, 'stephen', { group_id: gid })

    const role = await doAssignRole(inst, 'stephen', ROLE_KEYS, COMPOSITION)

    const g = await readGroup(inst, gid)
    const p = await readParticipant(inst, 'stephen')
    // Expected array is derived from the RETURNED role (a different source than the doc read).
    const arr = (g[fieldFor(role, 'participants')] as string[]) ?? []
    expect(arr).toHaveLength(1)                 // assert length before membership
    expect(arr).toContain('stephen')
    expect(g['lead_participant_id']).toBe('stephen') // lead was empty → becomes this member
    expect(p['is_lead']).toBe(true)
    expect(p['role']).toBe(role)                // role also on participant doc (unchanged behavior)
    expect(p['group_id']).toBe(gid)             // group_id (score path) untouched
  })

  it('preserves an existing lead; the back-filled member does NOT steal it', async () => {
    const inst = newInstanceId()
    const gid = 'g1'
    await seedGroup(inst, gid, { lead_participant_id: 'alice', buyer_participants: ['alice'], seller_participants: [] })
    await seedParticipant(inst, 'alice', { group_id: gid, role: 'buyer', is_lead: true })
    await seedParticipant(inst, 'stephen', { group_id: gid })

    const role = await doAssignRole(inst, 'stephen', ROLE_KEYS, COMPOSITION)

    const g = await readGroup(inst, gid)
    const p = await readParticipant(inst, 'stephen')
    expect((g[fieldFor(role, 'participants')] as string[])).toContain('stephen')
    expect(g['lead_participant_id']).toBe('alice')  // unchanged
    expect(p['is_lead']).not.toBe(true)             // did not become lead
  })

  it('REGRESSION: a match-first assignment (no group_id) writes NO group doc and behaves as before', async () => {
    const inst = newInstanceId()
    // A bystander group that must remain byte-identical — proves the fix is inert here.
    await seedGroup(inst, 'bystander', { lead_participant_id: 'x', buyer_participants: ['x'], seller_participants: [] })
    const before = JSON.stringify(await readGroup(inst, 'bystander'))
    await seedParticipant(inst, 'newbie', {}) // no role, NO group_id

    const role = await doAssignRole(inst, 'newbie', ROLE_KEYS, COMPOSITION)

    const p = await readParticipant(inst, 'newbie')
    expect(p['role']).toBe(role)                 // role on participant doc
    expect(p['role_assigned_at']).toBeTruthy()
    expect(p['group_id'] ?? null).toBeNull()     // still ungrouped
    const after = JSON.stringify(await readGroup(inst, 'bystander'))
    expect(after).toBe(before)                   // no group touched
  })

  it('IDEMPOTENCY: a concurrent double-assign adds the member exactly once', async () => {
    const inst = newInstanceId()
    const gid = 'g1'
    await seedGroup(inst, gid, { lead_participant_id: null, buyer_participants: [], seller_participants: [] })
    await seedParticipant(inst, 'stephen', { group_id: gid })

    // Two racing calls — Firestore serializes the transactions; the loser retries, sees the
    // role now set, and short-circuits. arrayUnion guards even if both had written.
    const [r1, r2] = await Promise.all([
      doAssignRole(inst, 'stephen', ROLE_KEYS, COMPOSITION),
      doAssignRole(inst, 'stephen', ROLE_KEYS, COMPOSITION),
    ])
    expect(r1).toBe(r2) // same role both times (single assignment)

    const g = await readGroup(inst, gid)
    const arr = (g[fieldFor(r1, 'participants')] as string[]) ?? []
    const occurrences = arr.filter(id => id === 'stephen').length
    expect(occurrences).toBe(1) // NOT double-added
  })
})
