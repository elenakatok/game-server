import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GameDefinition } from '../src/GameDefinition'

// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THE BUNDLE **DECLARES** — a different question from what the resolver CHOOSES.
//
// This file exists because of a real incident. A game whose definition correctly said
// `callbackSecretName: 'INFOSHARE_CALLBACK_SECRET'` still made `firebase deploy` stop and
// interactively offer to create `CLASSROOM_CALLBACK_SECRET`.
//
// Everything anyone had checked was true:
//   • `callbackSecretName(def)` returned INFOSHARE_CALLBACK_SECRET,
//   • the compiled `makeFinalizeInstance.js` called the new resolver,
//   • no function's `secrets: []` array mentioned the old name.
//
// The cause was a bare `callbackSecretParam()` at the bottom of callbackSecret.ts, which
// registered the DEFAULT name as a side effect of importing the module. The Firebase CLI
// enumerates every param **declared** in the loaded module graph — not only those bound
// to a function — so it found a secret that did not exist in that project.
//
// ⚠ THE LESSON, AND WHY THIS IS A SEPARATE TEST FILE: verifying which name the code
// CHOOSES cannot detect an extra name being DECLARED. They are different sets, and only
// the declared set is what the CLI acts on. Assert the set, not the choice.
// ═══════════════════════════════════════════════════════════════════════════════

/** Load the flow factories with `defineSecret` hooked, and report every declared name. */
async function declaredSecretsFor(def: GameDefinition): Promise<string[]> {
  const declared: string[] = []
  vi.resetModules()
  vi.doMock('firebase-functions/params', async (importOriginal) => {
    const actual = await importOriginal<typeof import('firebase-functions/params')>()
    return {
      ...actual,
      defineSecret: (name: string) => { declared.push(name); return actual.defineSecret(name) },
    }
  })
  const flow = await import('../src/index')
  // Call the factories exactly as a game's index.ts does, at module load.
  flow.makeFinalizeInstance(def)
  flow.makePushResultsToClassroom(def)
  flow.makeSyncRoster(def)
  return [...new Set(declared)]
}

const defWith = (classroom: GameDefinition['classroom']): GameDefinition =>
  ({ classroom, corsOrigins: ['https://example.test'] } as GameDefinition)

beforeEach(() => { vi.resetModules() })

describe('the DECLARED set', () => {
  it('a game with its OWN name declares ONLY that name', async () => {
    // The regression. Before the fix this also contained CLASSROOM_CALLBACK_SECRET, and
    // `firebase deploy` stopped to ask for a value.
    const declared = await declaredSecretsFor(defWith({
      callbackSecretId: 'infoshare_v1',
      callbackSecretName: 'INFOSHARE_CALLBACK_SECRET',
    }))
    expect(declared).toContain('INFOSHARE_CALLBACK_SECRET')
    expect(declared).not.toContain('CLASSROOM_CALLBACK_SECRET')
  })

  it('a game with NO override still declares the default — through the normal path', async () => {
    // The other half, and the reason the module-load registration was safe to delete:
    // every game calls these factories at import time, and each one registers the
    // resolved name itself. The nine live games rely on this.
    const declared = await declaredSecretsFor(defWith({ callbackSecretId: 'crisis_v1' }))
    expect(declared).toContain('CLASSROOM_CALLBACK_SECRET')
  })

  it('declares EXACTLY one callback secret either way', async () => {
    // Two callback secrets in one bundle is never right: one of them is unbound, and an
    // unbound declaration is what triggers the interactive prompt.
    for (const def of [
      defWith({ callbackSecretId: 'a_v1', callbackSecretName: 'A_CALLBACK_SECRET' }),
      defWith({ callbackSecretId: 'b_v1' }),
    ]) {
      const declared = await declaredSecretsFor(def)
      expect(declared.filter((n) => n.endsWith('CALLBACK_SECRET'))).toHaveLength(1)
    }
  })

  it('merely IMPORTING the module declares nothing', async () => {
    // The precise shape of the bug: a side effect at import time, before any factory is
    // called. If this ever fails again, someone has reintroduced a module-load
    // defineSecret and every overriding game will prompt on deploy.
    const declared: string[] = []
    vi.resetModules()
    vi.doMock('firebase-functions/params', async (importOriginal) => {
      const actual = await importOriginal<typeof import('firebase-functions/params')>()
      return {
        ...actual,
        defineSecret: (name: string) => { declared.push(name); return actual.defineSecret(name) },
      }
    })
    await import('../src/callbackSecret')
    expect(declared).toEqual([])
  })
})
