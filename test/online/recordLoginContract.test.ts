import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ═══════════════════════════════════════════════════════════════════════════════
// recordLogin MUST HAND BACK clock_mode. This file exists because of a real incident,
// and because the failure mode is SILENT.
//
// config/main is server-only readable, so a student UI has exactly one way to learn
// whether it is in an online or a classroom session: the clock_mode that recordLogin
// returns. Every game's routeToPhase does the same thing with it —
//
//     let m = 'on'
//     try { m = (await recordLogin()).clock_mode === 'off' ? 'off' : 'on' } catch {}
//
// — which means a MISSING field is indistinguishable from "classroom". Nothing throws,
// nothing logs, no test goes red. The online student is simply routed down the classroom
// join path: "only continue if you are in class right now" → the attendance-code screen →
// "no attendance code has been generated yet", for a code that CANNOT exist in a session
// that has no class to display one at. It blocks the student outright.
//
// The shared factory returned only { ok, group_id } and every game consuming it was
// broken in online mode. Crisis looked fine solely because it kept a LOCAL recordLogin
// that always returned clock_mode — it was never gated differently, just unaffected.
//
// ⚠ WHY A SOURCE GUARD RATHER THAN A BEHAVIOURAL TEST: the bug is a field ABSENT from a
// payload. A test that asserts what the resolver CHOOSES for a present field cannot see
// a field that was never put there — the same distinction declaredSecrets.test.ts was
// written for. So assert the field is in the returned shape, at the source.
// ═══════════════════════════════════════════════════════════════════════════════

const SRC = readFileSync(resolve(__dirname, '../../src/online/makeOnlineGrouping.ts'), 'utf8')

/** The body of makeRecordLogin, from its export to the start of the next export. */
function recordLoginBody(): string {
  const start = SRC.indexOf('export function makeRecordLogin')
  expect(start, 'makeRecordLogin must exist in makeOnlineGrouping.ts').toBeGreaterThan(-1)
  const rest = SRC.slice(start + 'export function makeRecordLogin'.length)
  const next = rest.search(/\nexport (function|interface|const|type) /)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('makeRecordLogin — the online-routing contract', () => {
  const body = recordLoginBody()

  it('returns clock_mode (the student UI cannot read config/main itself)', () => {
    expect(body).toMatch(/return\s*{[^}]*clock_mode/)
  })

  it('reads clock_mode from config/main, the one place every reader uses', () => {
    expect(body).toMatch(/config['"]?\)?\s*\)?[\s\S]{0,80}?main/)
    expect(body).toMatch(/\[['"]clock_mode['"]\]/)
  })

  it("defaults an absent clock_mode to 'on' — unset means CLASSROOM", () => {
    expect(body).toMatch(/\[['"]clock_mode['"]\]\s*\?\?\s*['"]on['"]/)
  })

  it('still returns group_id (it was insufficient, never wrong)', () => {
    expect(body).toMatch(/return\s*{[^}]*group_id/)
  })
})
