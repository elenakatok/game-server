import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'
import { parsePrepTextQuestions, mergeWithDefaults } from '../config/prepTextQuestions'
import { calcKCScore } from './calcKCScore'

/**
 * Grades a single graded static KC question for a student.
 * Returns { correct, explanation } — explanation IS sent post-answer (not pre-answer).
 *
 * Idempotent per field: if the question was already answered, returns the stored result.
 * After each answer, checks whether all graded static questions for this role are answered;
 * if so, computes and writes knowledge_check_score in the same transaction.
 *
 * Preconditions: role gate (knowledge_check_completed_at) must be set before this is callable.
 *
 * Call data: { field: string, answer: string } + student auth
 * Returns: { ok, correct, explanation }
 */
export function makeSubmitStaticKnowledgeCheckQuestion(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const { field, answer } = data
    if (typeof field !== 'string' || !field) {
      throw new HttpsError('invalid-argument', 'field must be a non-empty string')
    }
    if (typeof answer !== 'string' || !answer) {
      throw new HttpsError('invalid-argument', 'answer must be a non-empty string')
    }

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    const [participantSnap, configSnap] = await Promise.all([
      instanceRef.collection('participants').doc(participantId).get(),
      instanceRef.collection('config').doc('main').get(),
    ])

    const participantRole = (participantSnap.data() ?? {}).role as string | undefined
    if (!participantRole) {
      throw new HttpsError('unavailable', 'Role not yet assigned.')
    }

    const cd = (configSnap.data() ?? {}) as Record<string, unknown>
    const defaults = def.prepDefaults ?? []
    const stored = parsePrepTextQuestions(cd.prep_text_questions) ?? defaults
    const merged = mergeWithDefaults(stored, defaults)

    // Role-filtered graded static questions.
    const staticKCQuestions = merged.filter(q =>
      q.category === 'knowledge_check' &&
      q.grading === 'static' &&
      !!q.correct_value &&
      (q.role_target === 'all' || q.role_target === participantRole),
    )

    const question = staticKCQuestions.find(q => q.field === field)
    if (!question) {
      throw new HttpsError('invalid-argument', `'${field}' is not a valid graded KC question for your role.`)
    }

    const staticKCForScoring = staticKCQuestions.map(q => ({ field: q.field, correct_value: q.correct_value! }))
    const participantRef = instanceRef.collection('participants').doc(participantId)

    let resultCorrect = false
    let resultExplanation = ''

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(participantRef)
      if (!snap.exists) throw new HttpsError('not-found', 'Participant not found.')
      const pData = snap.data()!

      if (pData.knowledge_check_completed_at == null) {
        throw new HttpsError('failed-precondition', 'Role gate not yet completed.')
      }

      type KCAnswer = { answer: string; correct: boolean }
      const existing = (pData.kc_static_answers ?? {}) as Record<string, KCAnswer>

      // Idempotent: already answered — return stored result.
      if (existing[field] != null) {
        resultCorrect = existing[field].correct
        resultExplanation = question.explanation ?? ''
        return
      }

      const correct = answer === question.correct_value!
      resultCorrect = correct
      resultExplanation = question.explanation ?? ''

      // Build full answers map (existing + current) for potential score computation.
      const allAnswersMap: Record<string, string> = {}
      for (const [k, v] of Object.entries(existing)) allAnswersMap[k] = v.answer
      allAnswersMap[field] = answer

      const allAnswered = staticKCForScoring.every(q => q.field === field || existing[q.field] != null)

      const updateData: Record<string, unknown> = {
        [`kc_static_answers.${field}`]: { answer, correct, answered_at: FieldValue.serverTimestamp() },
      }

      if (allAnswered && pData.knowledge_check_score == null) {
        const { score } = calcKCScore(allAnswersMap, staticKCForScoring)
        updateData.knowledge_check_score = score
      }

      tx.update(participantRef, updateData)
    })

    return { ok: true, correct: resultCorrect, explanation: resultExplanation }
  })
}
