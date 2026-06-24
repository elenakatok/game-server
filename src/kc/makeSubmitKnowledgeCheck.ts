import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'
import { parsePrepTextQuestions, mergeWithDefaults } from '../config/prepTextQuestions'
import { calcKCScore } from './calcKCScore'

/**
 * Handles the KC role gate: validates the student's role self-identification answer,
 * increments attempt count, marks the gate complete on a correct answer.
 *
 * Zero-static short-circuit: if the gate is passed and this role has no graded static
 * KC questions, writes knowledge_check_score = 1.0 immediately.
 *
 * Idempotent once KC is fully complete (knowledge_check_score already set).
 * Idempotent once gate is passed (knowledge_check_completed_at already set).
 *
 * Call data: { answer: <roleKey> } + student auth (Bearer Firebase token or classroom JWT)
 * Returns: { ok, correct, alreadyCompleted, score, attempts }
 */
export function makeSubmitKnowledgeCheck(def: GameDefinition) {
  const validRoleKeys = new Set(def.roles.roles.map(r => r.key))

  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const answer = data.answer
    if (typeof answer !== 'string' || !validRoleKeys.has(answer)) {
      throw new HttpsError('invalid-argument', 'answer must be a valid role key for this game')
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const participantRef = instanceRef.collection('participants').doc(participantId)

    // Score the role gate inside a transaction.
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(participantRef)
      if (!snap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pData = snap.data()!
      const role = pData.role as string | undefined
      if (!role) throw new HttpsError('unavailable', 'Role not yet assigned.')

      // Full KC already complete — return stored result without side-effects.
      if (pData.knowledge_check_score != null) {
        return {
          correct: true,
          alreadyCompleted: true,
          score: pData.knowledge_check_score as number,
          attempts: pData.knowledge_check_attempts as number,
        }
      }
      // Gate already passed but static questions not yet submitted.
      if (pData.knowledge_check_completed_at != null) {
        return {
          correct: answer === role,
          alreadyCompleted: false,
          score: null,
          attempts: pData.knowledge_check_attempts as number,
        }
      }

      const prevAttempts = (pData.knowledge_check_attempts as number | undefined) ?? 0
      const newAttempts = prevAttempts + 1
      const correct = answer === role

      if (correct) {
        tx.update(participantRef, {
          knowledge_check_attempts: newAttempts,
          knowledge_check_completed_at: FieldValue.serverTimestamp(),
        })
        return { correct: true, alreadyCompleted: false, score: null, attempts: newAttempts }
      }
      tx.update(participantRef, { knowledge_check_attempts: newAttempts })
      return { correct: false, alreadyCompleted: false, score: null, attempts: newAttempts }
    })

    // Zero-static short-circuit: gate just passed and this role has no graded static questions.
    if (result.correct && !result.alreadyCompleted) {
      const configSnap = await instanceRef.collection('config').doc('main').get()
      const cd = (configSnap.data() ?? {}) as Record<string, unknown>
      const defaults = def.prepDefaults ?? []
      const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? defaults
      const merged = mergeWithDefaults(stored, defaults)
      const staticKCQuestions = merged.filter(q =>
        q.category === 'knowledge_check' &&
        q.grading === 'static' &&
        !!q.correct_value &&
        (q.role_target === 'all' || q.role_target === answer),
      )
      if (staticKCQuestions.length === 0) {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(participantRef)
          if ((snap.data() ?? {}).knowledge_check_score == null) {
            const { score } = calcKCScore({}, [])
            tx.update(participantRef, { knowledge_check_score: score })
          }
        })
      }
    }

    return { ok: true, ...result }
  })
}
