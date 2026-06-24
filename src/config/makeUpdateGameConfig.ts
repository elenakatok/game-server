import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'
import { validateWriteField, readConfigField } from './configField'
import { parsePrepTextQuestions, mergeWithDefaults, validateQuestionSemantics } from './prepTextQuestions'

/**
 * Returns an onCall function that writes a partial patch to game_instances/{id}/config/main.
 *
 * Only fields present in the request are written (merge: true — unlisted fields are never touched).
 * Recognised fields: any key declared in def.configFields, plus prep_text_questions.
 * At least one recognised field must be present; unknown keys are ignored.
 *
 * Call data (emulator): { _dev: { game_instance_id }, ...fields }
 * Call data (production): Bearer token (Authorization header), plus the same fields
 * Returns: full current config (all configFields + prep_text_questions) after the write.
 */
export function makeUpdateGameConfig(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    // Build the partial update — only validated, present fields are written.
    const update: Record<string, unknown> = {}

    for (const field of (def.configFields ?? [])) {
      if (!(field.key in data)) continue
      update[field.key] = validateWriteField(field, data[field.key])
    }

    if ('prep_text_questions' in data) {
      const parsed = parsePrepTextQuestions(data['prep_text_questions'])
      if (parsed === null) {
        throw new HttpsError(
          'invalid-argument',
          'prep_text_questions: invalid shape — must be an array of ' +
          '{field(prep_*/kc_*/debrief_*),prompt,placeholder,order,hidden,deletable} with unique field names',
        )
      }
      const semanticError = validateQuestionSemantics(parsed)
      if (semanticError !== null) {
        throw new HttpsError('invalid-argument', `prep_text_questions: ${semanticError}`)
      }
      update['prep_text_questions'] = parsed
    }

    if (Object.keys(update).length === 0) {
      throw new HttpsError('invalid-argument', 'No recognised fields to update')
    }

    try {
      const db = admin.firestore()
      const ref = db
        .collection('game_instances').doc(gameInstanceId)
        .collection('config').doc('main')

      await ref.set(update, { merge: true })

      // Re-read the full doc so the response reflects authoritative current state of every field.
      const snap = await ref.get()
      const cd = (snap.data() ?? {}) as Record<string, unknown>

      const result: Record<string, unknown> = { ok: true as const }

      for (const field of (def.configFields ?? [])) {
        result[field.key] = readConfigField(field, cd[field.key])
      }

      const defaults = def.prepDefaults ?? []
      const stored = parsePrepTextQuestions(cd['prep_text_questions']) ?? defaults
      result['prep_text_questions'] = mergeWithDefaults(stored, defaults)

      return result
    } catch (err) {
      if (err instanceof HttpsError) throw err
      console.error('[updateGameConfig] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
