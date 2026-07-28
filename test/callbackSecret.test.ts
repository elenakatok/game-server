import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_CALLBACK_SECRET_NAME,
  callbackSecretName,
  callbackSecretParam,
  callbackSecretValue,
} from '../src/callbackSecret'
import type { GameDefinition } from '../src/GameDefinition'

// ═══════════════════════════════════════════════════════════════════════════════
// THE PER-GAME CALLBACK SECRET NAME.
//
// The whole point of these tests is the DEFAULT path: nine live games depend on it, and
// "additive" is a claim that has to be checked rather than asserted in a commit message.
// Every test below that names CLASSROOM_CALLBACK_SECRET is a regression test for those
// nine games, not a test of the new feature.
// ═══════════════════════════════════════════════════════════════════════════════

const defWith = (classroom: GameDefinition['classroom']): GameDefinition =>
  ({ classroom } as GameDefinition)

const ENV_KEYS = ['CLASSROOM_CALLBACK_SECRET', 'INFOSHARE_CALLBACK_SECRET']
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k] })

describe('the default path — the nine existing games', () => {
  it('a game that says nothing gets CLASSROOM_CALLBACK_SECRET', () => {
    expect(callbackSecretName(defWith({ callbackSecretId: 'crisis_v1' })))
      .toBe('CLASSROOM_CALLBACK_SECRET')
  })

  it('the exported default constant IS that name', () => {
    expect(DEFAULT_CALLBACK_SECRET_NAME).toBe('CLASSROOM_CALLBACK_SECRET')
  })

  it('an explicitly undefined callbackSecretName still falls back', () => {
    // A game that spreads a config object may end up with the key present and undefined.
    // That must behave as absent, not as a request for a secret named "undefined".
    expect(callbackSecretName(defWith({ callbackSecretId: 'x_v1', callbackSecretName: undefined })))
      .toBe('CLASSROOM_CALLBACK_SECRET')
  })

  it('reads the SAME environment variable it did before', () => {
    process.env.CLASSROOM_CALLBACK_SECRET = 'legacy-value'
    expect(callbackSecretValue('CLASSROOM_CALLBACK_SECRET')).toBe('legacy-value')
  })

  it('missing env resolves to empty string, not undefined', () => {
    // Downstream code does `if (!callbackSecret)`; undefined would still be falsy, but
    // `secretLen` logging and the Bearer header would read "undefined".
    expect(callbackSecretValue('CLASSROOM_CALLBACK_SECRET')).toBe('')
  })

  it('the emulator _dev override still wins over the environment', () => {
    process.env.CLASSROOM_CALLBACK_SECRET = 'from-env'
    expect(callbackSecretValue('CLASSROOM_CALLBACK_SECRET', 'from-dev')).toBe('from-dev')
  })
})

describe('the override path — a game with its own secret', () => {
  it('a declared name is used verbatim', () => {
    expect(callbackSecretName(defWith({
      callbackSecretId: 'infoshare_v1',
      callbackSecretName: 'INFOSHARE_CALLBACK_SECRET',
    }))).toBe('INFOSHARE_CALLBACK_SECRET')
  })

  it('the VALUE is read from the declared name, not the default', () => {
    // This is the half that is easy to miss: binding the right secret but still reading
    // process.env.CLASSROOM_CALLBACK_SECRET resolves to empty and 403s identically.
    process.env.INFOSHARE_CALLBACK_SECRET = 'infoshare-value'
    process.env.CLASSROOM_CALLBACK_SECRET = 'pennies-value'
    expect(callbackSecretValue('INFOSHARE_CALLBACK_SECRET')).toBe('infoshare-value')
  })

  it('a game with its own name does NOT fall back to the default value', () => {
    process.env.CLASSROOM_CALLBACK_SECRET = 'pennies-value'
    // Its own secret is unset — the correct answer is empty (and a loud failure
    // downstream), never another game's secret.
    expect(callbackSecretValue('INFOSHARE_CALLBACK_SECRET')).toBe('')
  })
})

describe('the param registry', () => {
  it('returns the SAME param object for a repeated name', () => {
    // Three factories register the same name in one bundle; distinct objects per call
    // site are at best wasteful and at worst ambiguous for the CLI.
    expect(callbackSecretParam('CLASSROOM_CALLBACK_SECRET'))
      .toBe(callbackSecretParam('CLASSROOM_CALLBACK_SECRET'))
  })

  it('defaults to the historical name when called with no argument', () => {
    expect(callbackSecretParam()).toBe(callbackSecretParam('CLASSROOM_CALLBACK_SECRET'))
  })

  it('returns DIFFERENT params for different names', () => {
    expect(callbackSecretParam('INFOSHARE_CALLBACK_SECRET'))
      .not.toBe(callbackSecretParam('CLASSROOM_CALLBACK_SECRET'))
  })

  it('the param carries the requested name', () => {
    expect(callbackSecretParam('INFOSHARE_CALLBACK_SECRET').name).toBe('INFOSHARE_CALLBACK_SECRET')
  })
})
