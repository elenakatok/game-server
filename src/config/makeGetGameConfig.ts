import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'
import { readConfigField } from './configField'
import { parsePrepTextQuestions, mergeWithDefaults } from './prepTextQuestions'

/**
 * Returns an onCall function that reads the full game config for a Settings page.
 *
 * Always returns prep_text_questions (merged with any missing system defaults from def.prepDefaults).
 * Also returns any game-specific fields declared in def.configFields, falling back to their defaults.
 *
 * Call data (emulator): { _dev: { game_instance_id } }
 * Call data (production): Bearer token (Authorization header) or { token: "<classroom JWT>" }
 * Returns: { ok: true, prep_text_questions, ...configFields }
 */
export function makeGetGameConfig(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

    try {
      const db = admin.firestore()
      const snap = await db
        .collection('game_instances').doc(gameInstanceId)
        .collection('config').doc('main')
        .get()
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
      console.error('[getGameConfig] error:', err)
      throw new HttpsError('internal', 'Internal error')
    }
  })
}
