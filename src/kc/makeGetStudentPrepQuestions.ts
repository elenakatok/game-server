import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'
import { parsePrepTextQuestions, mergeWithDefaults } from '../config/prepTextQuestions'
import { djb2Hash, seededShuffle } from './shuffle'

/**
 * Returns the visible, ordered KC + prep questions for a student's session.
 * - Role-filters to questions targeting the student's assigned role (or 'all').
 * - Excludes hidden questions and debrief questions.
 * - Strips answer keys (correct_value, grading, explanation) — must not reach client pre-submission.
 * - Applies a deterministic per-student shuffle of MC options (seed = djb2(participantId + ':' + field)).
 *
 * Falls back to the game's full prepDefaults when no questions are stored in config/main.
 */
export function makeGetStudentPrepQuestions(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [configSnap, participantSnap] = await Promise.all([
      instanceRef.collection('config').doc('main').get(),
      instanceRef.collection('participants').doc(participantId).get(),
    ])

    const participantRole = (participantSnap.data() ?? {}).role as string | undefined
    if (!participantRole) {
      throw new HttpsError('unavailable', 'Role not yet assigned.')
    }

    const cd = (configSnap.data() ?? {}) as Record<string, unknown>
    const defaults = def.prepDefaults ?? []
    // Fall back to full defaults (including non-system questions) on fresh instances.
    const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? defaults
    const merged = mergeWithDefaults(stored, defaults)

    const visible = merged
      .filter(q =>
        !q.hidden &&
        q.category !== 'debrief' &&
        (q.role_target === 'all' || q.role_target === participantRole),
      )
      .sort((a, b) => a.order - b.order)

    // Strip answer key — correct_value, grading, explanation must not reach the client pre-submission.
    const sanitized = visible.map(({ correct_value: _cv, grading: _g, explanation: _ex, ...rest }) => rest)

    // Deterministic per-student option shuffle. Seed = djb2(participantId + ':' + field).
    const shuffled = sanitized.map(q => {
      if (q.type !== 'mc' || !q.options || q.options.length <= 1) return q
      const seed = djb2Hash(`${participantId}:${q.field}`)
      return { ...q, options: seededShuffle(q.options, seed) }
    })

    return { ok: true, questions: shuffled }
  })
}
