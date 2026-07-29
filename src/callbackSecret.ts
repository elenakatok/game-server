import { defineSecret } from 'firebase-functions/params'
import type { GameDefinition } from './GameDefinition'

// ═══════════════════════════════════════════════════════════════════════════════
// THE GAME-SIDE CALLBACK SECRET — one name per game, resolved in one place.
//
// Every game stores the shared classroom↔game callback secret in its OWN Firebase
// project. Historically the name was a constant, `CLASSROOM_CALLBACK_SECRET`, hardcoded
// at module load in three separate factories.
//
// ── WHY THAT WAS A PROBLEM ────────────────────────────────────────────────────
// `CLASSROOM_CALLBACK_SECRET` is not a generic name. It is *pennies'* secret name, kept
// as the default for historical reasons, and `scripts/spawn-secret.sh` will provision a
// game under a DIFFERENT name when `game-locations.json` gives it a `gameSecretName`.
// A game whose script wrote `INFOSHARE_CALLBACK_SECRET` but whose deployed functions
// bound `CLASSROOM_CALLBACK_SECRET` would fail in the worst possible way: the deploy
// reports success, and every gradebook push 403s in front of a class.
//
// ── WHY THIS IS A GameDefinition FIELD AND NOT A PER-FACTORY ARGUMENT ────────
// Three factories need the name, and a game passing it to two of the three is exactly
// the latent 403 this change exists to prevent. There is no game that legitimately wants
// different names for finalize, push and roster sync — they must all read the same
// secret, or the handshake is broken by construction. A single per-game field makes the
// broken state unrepresentable; three arguments make it one forgetful edit away.
//
// ⚠ ADDITIVE AND DEFAULTED. A game that says nothing gets `CLASSROOM_CALLBACK_SECRET`,
// byte-for-byte the previous behaviour. All nine consuming games are unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

/** The historical name. Every game that does not override keeps this. */
export const DEFAULT_CALLBACK_SECRET_NAME = 'CLASSROOM_CALLBACK_SECRET'

/**
 * `defineSecret` memoised by name.
 *
 * Memoised because the same name is registered by three factories in one bundle, and a
 * distinct param object per call site is at best wasteful and at worst an ambiguity in
 * what the CLI provisions. One object per name, for the life of the process.
 */
const params = new Map<string, ReturnType<typeof defineSecret>>()

export function callbackSecretParam(name: string = DEFAULT_CALLBACK_SECRET_NAME) {
  let p = params.get(name)
  if (p === undefined) {
    p = defineSecret(name)
    params.set(name, p)
  }
  return p
}

/**
 * The name this game uses. Falls back to the historical constant.
 *
 * ⚠ MUST MATCH `gameSecretName` for this game in `scripts/game-locations.json`, which is
 * what `spawn-secret.sh` writes into the game's Secret Manager and into
 * `functions/.secret.local`. If the two disagree the symptom is a 403 on every callback,
 * with a deploy that reported success — check the code AND the manifest, not just one.
 */
export function callbackSecretName(def: GameDefinition): string {
  return def.classroom?.callbackSecretName ?? DEFAULT_CALLBACK_SECRET_NAME
}

/**
 * The secret's VALUE at request time: the emulator's `_dev` override, then the named
 * environment variable, then empty.
 *
 * Reading `process.env[name]` rather than `process.env.CLASSROOM_CALLBACK_SECRET` is the
 * other half of the fix — binding the right secret but still reading the old variable
 * would resolve to empty and produce the identical 403.
 */
export function callbackSecretValue(name: string, devOverride?: string): string {
  return devOverride ?? process.env[name] ?? ''
}

// ── NO MODULE-LOAD REGISTRATION HERE, AND THAT IS THE POINT ───────────────────
//
// There used to be a bare `callbackSecretParam()` on this line, registering the DEFAULT
// name unconditionally on import "to preserve the timing the CLI relies on". It was
// unnecessary and actively harmful:
//
//   • UNNECESSARY, because every game calls `makeFinalizeInstance(def)` and friends at
//     module load in its own index.ts, and each factory calls `callbackSecretParam(...)`
//     with the resolved name. A game that does not override therefore registers
//     CLASSROOM_CALLBACK_SECRET through the normal path anyway. (Regression-tested.)
//
//   • HARMFUL, because a game that DOES override then declared BOTH names. The Firebase
//     CLI enumerates every param DECLARED in the loaded module graph — not only those a
//     function binds — so it found a secret that does not exist in that game's project
//     and interactively offered to create one. Answering would have minted an orphan no
//     function reads.
//
// ⚠ DO NOT REINTRODUCE A MODULE-LOAD `defineSecret` HERE. What a resolver CHOOSES and
// what a bundle DECLARES are different questions, and only the second is what the CLI
// acts on.
