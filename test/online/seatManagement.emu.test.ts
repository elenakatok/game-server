// Emulator integration tests for the seat machinery against REAL Firestore documents.
// Gated on FIRESTORE_EMULATOR_HOST, so a plain `vitest run` skips them; run with:
//
//   firebase emulators:exec --only firestore --project demo-online \
//     "npx vitest run test/online/seatManagement.emu.test.ts"
//
// The unit tests prove the invariants over plain objects. THIS proves the same
// operations survive the round trip through stored documents — read the doc through
// the adapter, operate, write the patch back, and assert what actually landed.
//
// ⚠ EVERYTHING IS RUN AT n=2 AND n=3. The recorded O2.1 failure was a control gated
// on "a free seat exists somewhere", true in short-group seed data and false for a
// real full class. So the fixtures here are PRODUCTION-SHAPED: full groups, a class
// with no free seat anywhere, and bot-backed groups — not a convenient short group.

import { describe, it, expect, beforeAll } from 'vitest'
import * as admin from 'firebase-admin'
import { makeStageGroupAdapter, toSeatGroup } from '../../src/online/groupDocAdapter'
import { canAcceptHuman, fillWithBots, leadOf, moveOccupant } from '../../src/online/seatOps'
import type { SeatOccupant } from '../../src/online/types'

const EMU = !!process.env.FIRESTORE_EMULATOR_HOST
const d = EMU ? describe : describe.skip

const adapter = makeStageGroupAdapter()
let db: admin.firestore.Firestore
let seq = 0

beforeAll(() => {
  if (!EMU) return
  if (admin.apps.length === 0) admin.initializeApp({ projectId: 'demo-online' })
  db = admin.firestore()
})

const newInstance = () => `inst_${Date.now()}_${seq++}`
const groups = (iid: string) => db.collection('game_instances').doc(iid).collection('groups')

const human = (id: string): SeatOccupant =>
  ({ participantId: id, isBot: false, role: null, displayName: id.toUpperCase(), email: `${id}@x.edu` })
const bot = (id: string): SeatOccupant => ({ participantId: id, isBot: true, role: null })

/** Write a group doc through the adapter, exactly as a callable would. */
async function seedGroup(iid: string, groupId: string, occupants: SeatOccupant[], started = false) {
  const fields = adapter.newGroupFields({
    groupId, gameInstanceId: iid, existing: null, occupants,
    lead: leadOf({ groupId, occupants, started: false }),
    now: admin.firestore.FieldValue.serverTimestamp(),
  })
  if (started) fields['seats_locked_at'] = admin.firestore.FieldValue.serverTimestamp()
  await groups(iid).doc(groupId).set(fields)
}

const readGroup = async (iid: string, groupId: string) => {
  const s = await groups(iid).doc(groupId).get()
  return toSeatGroup(adapter, groupId, s.data() ?? {})
}

/** Apply a move the way a callable does: read → operate → write both patches. */
async function doMove(iid: string, participantId: string, fromId: string | null, toId: string | null, seatCount: number) {
  const source = fromId ? await readGroup(iid, fromId) : null
  const target = toId ? await readGroup(iid, toId) : null
  const r = moveOccupant({ participantId, source, target, seatCount, occupant: human(participantId) })
  if (!r.ok) return r
  const batch = db.batch()
  for (const g of [r.source, r.target]) {
    if (!g) continue
    const snap = await groups(iid).doc(g.groupId).get()
    batch.update(
      groups(iid).doc(g.groupId),
      adapter.writeMembership({ existing: snap.data() ?? null, occupants: g.occupants, lead: leadOf(g) }),
    )
  }
  await batch.commit()
  return r
}

for (const n of [2, 3]) {
  d(`seat management against real documents — n=${n}`, () => {
    it('a move rewrites BOTH documents and leaves nobody in two groups', async () => {
      const iid = newInstance()
      await seedGroup(iid, 'A', [human('a1'), human('a2')].slice(0, n))
      await seedGroup(iid, 'B', [human('b1')])

      const r = await doMove(iid, 'a1', 'A', 'B', n)
      expect(r.ok).toBe(true)

      const a = await readGroup(iid, 'A')
      const b = await readGroup(iid, 'B')
      expect(a.occupants.some((o) => o.participantId === 'a1')).toBe(false)
      expect(b.occupants.some((o) => o.participantId === 'a1')).toBe(true)

      const all = [...a.occupants, ...b.occupants].map((o) => o.participantId)
      expect(new Set(all).size).toBe(all.length)
    })

    it('ungroup leaves the group standing, with a free seat, in the STORED doc', async () => {
      const iid = newInstance()
      await seedGroup(iid, 'A', Array.from({ length: n }, (_, i) => human(`a${i}`)))

      await doMove(iid, 'a0', 'A', null, n)

      const snap = await groups(iid).doc('A').get()
      expect(snap.exists).toBe(true)                      // standing, not deleted
      const a = toSeatGroup(adapter, 'A', snap.data() ?? {})
      expect(a.occupants).toHaveLength(n - 1)
      expect(snap.data()?.lead_participant_id).toBe(n > 1 ? 'a1' : null)
    })

    it('a human replaces a bot, and the bot leaves BOTH arrays', async () => {
      const iid = newInstance()
      const bots = Array.from({ length: n - 1 }, (_, i) => bot(`bot_${i + 1}`))
      await seedGroup(iid, 'B', [human('b0'), ...bots])
      await seedGroup(iid, 'A', [human('x')])

      const r = await doMove(iid, 'x', 'A', 'B', n)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.evictedBot).toBe(`bot_${n - 1}`)

      const doc = (await groups(iid).doc('B').get()).data() ?? {}
      expect(doc.player_participants).toContain('x')
      expect(doc.player_participants).not.toContain(`bot_${n - 1}`)
      expect(doc.bot_participants).not.toContain(`bot_${n - 1}`)
      expect(doc.bot_count).toBe(n - 2)
    })

    it('a started group is frozen, and a DIFFERENT group is not', async () => {
      const iid = newInstance()
      await seedGroup(iid, 'LOCKED', Array.from({ length: n }, (_, i) => human(`l${i}`)), true)
      await seedGroup(iid, 'OPEN1', [human('o1')])
      await seedGroup(iid, 'OPEN2', [])

      // Into the locked group: refused.
      const into = await doMove(iid, 'o1', 'OPEN1', 'LOCKED', n)
      expect(into.ok).toBe(false)
      // Out of the locked group: refused.
      const outOf = await doMove(iid, 'l0', 'LOCKED', 'OPEN2', n)
      expect(outOf.ok).toBe(false)
      // Between two open groups: allowed, while LOCKED is mid-game.
      const between = await doMove(iid, 'o1', 'OPEN1', 'OPEN2', n)
      expect(between.ok).toBe(true)

      const locked = await readGroup(iid, 'LOCKED')
      expect(locked.occupants).toHaveLength(n)   // untouched by any of it
    })

    it('bot-fill lands the right arrays in the stored doc', async () => {
      const iid = newInstance()
      await seedGroup(iid, 'A', [human('a')])
      const g = await readGroup(iid, 'A')
      const r = fillWithBots({ group: g, seatCount: n, mint: (i) => bot(`bot_${i}`) })
      expect(r.ok).toBe(true)
      if (!r.ok) return

      const snap = await groups(iid).doc('A').get()
      await groups(iid).doc('A').update(
        adapter.writeMembership({ existing: snap.data() ?? null, occupants: r.group.occupants, lead: leadOf(r.group) }),
      )

      const doc = (await groups(iid).doc('A').get()).data() ?? {}
      expect(doc.player_participants).toHaveLength(n)
      expect(doc.bot_participants).toHaveLength(n - 1)
      expect(doc.bot_count).toBe(n - 1)
      expect(doc.lead_participant_id).toBe('a')   // a bot never leads
      // members[] stays HUMANS ONLY even after filling.
      expect((doc.members as unknown[])).toHaveLength(1)
    })

    it('PRODUCTION-SHAPED: a full class with no free seat anywhere still has destinations', async () => {
      // The O2.1 trap. Every group is full, so a global "is there a free seat" is
      // FALSE — yet the bot-backed groups are perfectly valid destinations, and a
      // control gated on the global answer would render nothing at all.
      const iid = newInstance()
      const full = Array.from({ length: n }, (_, i) => human(`f${i}`))
      const botBacked = [...Array.from({ length: n - 1 }, (_, i) => human(`p${i}`)), bot('bot_1')]
      await seedGroup(iid, 'FULL1', full)
      await seedGroup(iid, 'FULL2', full.map((h) => human(`${h.participantId}x`)))
      await seedGroup(iid, 'BOTTED', botBacked)

      const all = await Promise.all(['FULL1', 'FULL2', 'BOTTED'].map((g) => readGroup(iid, g)))
      expect(all.every((g) => g.occupants.length === n)).toBe(true)   // no free seat anywhere

      const acceptors = all.filter((g) => canAcceptHuman(g, n)).map((g) => g.groupId)
      expect(acceptors).toEqual(['BOTTED'])                            // …but a destination exists
    })
  })
}

d('a re-group is refused once ANY group has started (instance-wide)', () => {
  it('distinguishes the instance-wide lock from the per-group one', async () => {
    const iid = newInstance()
    await seedGroup(iid, 'A', [human('a')], true)
    await seedGroup(iid, 'B', [human('b')])

    const snap = await groups(iid).get()
    const anyStarted = snap.docs.some((doc) => adapter.hasStarted(doc.data()))
    expect(anyStarted).toBe(true)   // → groupParticipantsOnline refuses

    // …while B, per-group, is still perfectly movable.
    const b = await readGroup(iid, 'B')
    expect(b.started).toBe(false)
    expect(canAcceptHuman(b, 3)).toBe(true)
  })
})
