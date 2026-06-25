import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'
import { parsePrepTextQuestions, mergeWithDefaults } from '../config/prepTextQuestions'

/**
 * Returns the visible, ordered debrief questions for a student's session.
 * Filters to category === 'debrief', role-filtered, not hidden.
 * Does not strip answer keys (debrief questions are ungraded free-text).
 * Falls back to def.prepDefaults when no config stored.
 *
 * Call data (emulator): { _test: { participant_id, game_instance_id } }
 * Call data (production): Bearer token or { token }
 * Returns: { ok: true, questions: PrepTextQuestion[] }
 */
export function makeGetDebriefQuestions(def: GameDefinition) {
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
    const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? defaults
    const merged = mergeWithDefaults(stored, defaults)

    const visible = merged
      .filter(q =>
        !q.hidden &&
        q.category === 'debrief' &&
        (q.role_target === 'all' || q.role_target === participantRole),
      )
      .sort((a, b) => a.order - b.order)

    return { ok: true, questions: visible }
  })
}
