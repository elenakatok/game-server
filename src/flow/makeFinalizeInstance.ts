import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { computeZScoresByRole, isValidRole, type ScoringRecord, type Outcome } from '@mygames/game-engine'
import { extractInstructorGameId } from '../auth/instructorAuth'
import { dispatchResults, toGameResult, type GameResult, type PushSummary } from '../classroom/reportResult'
import type { GameDefinition } from '../GameDefinition'

// All games store the classroom callback secret under this name in their own project.
// Registered at module load so the Firebase CLI provisions it for finalizeInstance —
// finalize now dispatches results itself (see Fix 1), so it needs the secret too.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/** Resolves the classroom callback URL + secret (prod env, with emulator _dev override). */
function resolveCallbackConfig(data: Record<string, unknown>, isEmulator: boolean): { url: string; secret: string } {
  const dev = isEmulator && data['_dev'] != null ? (data['_dev'] as Record<string, unknown>) : null
  return {
    url: (dev?.['callback_url'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_URL ?? '',
    secret: (dev?.['callback_secret'] as string | undefined) ?? process.env.CLASSROOM_CALLBACK_SECRET ?? '',
  }
}

export type CompletedGroup = {
  outcome: Outcome | null
  agreement_reached: boolean
}

/**
 * Pure helper — exported for unit testing.
 * Returns a ScoringRecord for a participant with a role, or null for roleless participants.
 *
 * Status priority:
 *   completed group found → 'completed'  (deal or walk-away; both stay in the scored pool)
 *   participant_late === true → 'late'    (present but unplaceable; excluded from distribution)
 *   otherwise → 'no_show'               (never matched; excluded; receives −2 floor marker)
 *
 * Knowledge-check score is carried from the Firestore participant doc.
 */
export function buildScoringRecord(
  participantId: string,
  data: Record<string, unknown>,
  completedGroups: Map<string, CompletedGroup>,
): ScoringRecord | null {
  const role = data['role'] as string | undefined
  if (!role) return null

  const groupId = data['group_id'] as string | undefined
  const groupOutcome = groupId ? completedGroups.get(groupId) : undefined

  const status: ScoringRecord['status'] =
    groupOutcome !== undefined ? 'completed'
    : data['participant_late'] === true ? 'late'
    : 'no_show'

  return {
    participant_id: participantId,
    role,
    status,
    agreement_reached: groupOutcome?.agreement_reached ?? false,
    outcome: groupOutcome?.outcome ?? null,
    knowledge_check_score: (data['knowledge_check_score'] ?? null) as number | null,
  }
}

/**
 * Returns an onCall function that finalizes a game instance.
 *
 * Guard: every group must be status:'completed' — returns 400 if any are not yet resolved.
 * Builds ScoringRecord[] adopting grays improvements:
 *   (a) participant_late === true → 'late' classification (excluded from distribution, normalized_score: null)
 *   (b) knowledge_check_score read from Firestore participant doc (not hardcoded null)
 *   (c) roleless participants (enrolled but never joined) receive normalized_score: −2 in a second pass
 *
 * Delegates normalization to game-engine's computeZScoresByRole with def.roles,
 * def.scoreSense, and def.computeRawScore. No scoring constants live in this factory.
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, scored: number }
 */
export function makeFinalizeInstance(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins, secrets: [classroomCallbackSecret] }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)
    const { url: callbackUrl, secret: callbackSecret } = resolveCallbackConfig(data, isEmulator)

    // Pushes a record set to the classroom; no-op (succeeds) when no callback configured.
    const push = async (records: GameResult[]): Promise<PushSummary> => {
      if (!callbackUrl) {
        console.warn('[finalizeInstance] CLASSROOM_CALLBACK_URL not configured — scores written, push skipped')
        return { total: 0, succeeded: 0, failed: [] }
      }
      const summary = await dispatchResults(records, callbackUrl, callbackSecret)
      console.log('[finalizeInstance] push summary:', JSON.stringify(summary))
      return summary
    }

    try {
      const db = admin.firestore()
      const instanceRef = db.collection('game_instances').doc(gameInstanceId)

      // ── Fix 2: idempotency guard ────────────────────────────────────────────
      // If already finalized, DO NOT recompute or overwrite. Re-read the settled
      // (already-committed, no race here) scores and just re-DELIVER them to the
      // gradebook — so a re-click recovers from a failed push without ever changing
      // a grade. Returns reFinalized:true so the caller can distinguish.
      const instanceSnap = await instanceRef.get()
      if (instanceSnap.exists && instanceSnap.data()?.['finalized_at'] != null) {
        const settled = await instanceRef.collection('participants').get()
        const records = settled.docs
          .filter(d => d.data()['finalized_at'] != null)
          .map(d => toGameResult(gameInstanceId, d.id, d.data(), def.roles))
        const summary = await push(records)
        return { ok: true as const, scored: records.length, reFinalized: true as const, push: summary }
      }

      // 1. Read all groups; guard: every group must be status:'completed'.
      const groupsSnap = await instanceRef.collection('groups').get()
      for (const gdoc of groupsSnap.docs) {
        if (gdoc.data()['status'] !== 'completed') {
          throw new HttpsError(
            'failed-precondition',
            `Group ${gdoc.id} is not resolved — resolve all groups before finalizing.`,
          )
        }
      }

      // Build completed-group lookup: group_id → { outcome, agreement_reached }.
      const completedGroups = new Map<string, CompletedGroup>()
      for (const gdoc of groupsSnap.docs) {
        const d = gdoc.data()
        completedGroups.set(gdoc.id, {
          outcome: (d['outcome'] as Outcome | null) ?? null,
          agreement_reached: Boolean(d['agreement_reached']),
        })
      }

      // 2. Read all participants + config (config feeds reservation prices into scoring).
      const [participantsSnap, configSnap] = await Promise.all([
        instanceRef.collection('participants').get(),
        instanceRef.collection('config').doc('main').get(),
      ])
      const configData = (configSnap.data() ?? {}) as Record<string, unknown>

      // 3. First pass: build ScoringRecord[] for role-bearing participants.
      const records: ScoringRecord[] = []
      for (const pdoc of participantsSnap.docs) {
        const record = buildScoringRecord(
          pdoc.id,
          pdoc.data() as Record<string, unknown>,
          completedGroups,
        )
        if (record !== null) records.push(record)
      }

      // 4. Normalize: game-engine handles per-role pools, sample SD (÷N−1), cost-sense
      //    negation, no_show → −2, late → null, walk-away pool inclusion.
      //    Wrap computeRawScore to thread configData through without changing game-engine types.
      const scorer = (role: string, outcome: Outcome | null) => def.computeRawScore(role, outcome, configData)
      const finalized = computeZScoresByRole(records, def.roles, def.scoreSense, scorer)

      // Build lookup for games that provide computeScoreBreakdown (stores value_or_cost).
      const recordMap = def.computeScoreBreakdown
        ? new Map(records.map(r => [r.participant_id, r]))
        : null

      // 5. Write scores for role-bearing participants.
      //    When the game provides computeScoreBreakdown, also store value_or_cost (pure addition).
      const now = FieldValue.serverTimestamp()
      const batch = db.batch()
      for (const f of finalized) {
        const rec = recordMap?.get(f.participant_id)
        const breakdown = (def.computeScoreBreakdown && rec)
          ? def.computeScoreBreakdown(rec.role, rec.outcome, configData)
          : null
        batch.update(instanceRef.collection('participants').doc(f.participant_id), {
          raw_score: f.raw_score,
          normalized_score: f.normalized_score,
          knowledge_check_score: f.knowledge_check_score,
          finalized_at: now,
          ...(breakdown !== null ? { value_or_cost: breakdown.value_or_cost } : {}),
        })
      }

      // 6. Second pass: participants WITHOUT a valid game role — enrolled but never
      //    joined, or any null / empty-string / unrecognised role. Excluded from z-score
      //    math; receive the −2 floor marker so the push includes them. Same predicate
      //    (isValidRole) the push uses, so a −2 written here always reaches the gradebook.
      //    Skip docs already written in the scoring pass above (a non-null invalid role
      //    can land there) — Firestore rejects two writes to one doc in a single batch.
      const scoredIds = new Set(finalized.map((f) => f.participant_id))
      const rolelessPids: string[] = []
      for (const pdoc of participantsSnap.docs) {
        if (scoredIds.has(pdoc.id)) continue
        const role = pdoc.data()['role']
        if (typeof role === 'string' && isValidRole(def.roles, role)) continue
        batch.update(
          instanceRef.collection('participants').doc(pdoc.id),
          { raw_score: null, normalized_score: -2, finalized_at: now },
        )
        rolelessPids.push(pdoc.id)
      }

      // Instance-level finalized marker — the idempotency guard (Fix 2) and the
      // dashboard's server-derived "✓ Finalized" state (Fix 3) both read this.
      batch.set(instanceRef, { finalized_at: now, finalized: true }, { merge: true })

      await batch.commit()

      // ── Fix 1: push the records we JUST computed — NO re-read, no visibility race.
      // Build the exact same payload pushResultsToClassroom would (via toGameResult),
      // but from the in-memory computed scores + the docs already in hand. Every
      // finalized participant (incl. roleless −2 no-shows) is included.
      const computed = new Map<string, Record<string, unknown>>()
      for (const f of finalized) {
        computed.set(f.participant_id, {
          raw_score: f.raw_score,
          normalized_score: f.normalized_score,
          knowledge_check_score: f.knowledge_check_score,
        })
      }
      for (const pid of rolelessPids) {
        const doc = participantsSnap.docs.find(d => d.id === pid)
        computed.set(pid, {
          raw_score: null,
          normalized_score: -2,
          knowledge_check_score: (doc?.data()['knowledge_check_score'] ?? null) as number | null,
        })
      }
      const pushRecords: GameResult[] = participantsSnap.docs
        .filter(d => computed.has(d.id))
        .map(d => toGameResult(gameInstanceId, d.id, { ...d.data(), ...computed.get(d.id)! }, def.roles))

      const summary = await push(pushRecords)
      return { ok: true as const, scored: finalized.length + rolelessPids.length, push: summary }
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[finalizeInstance] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
