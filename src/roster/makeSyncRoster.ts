import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '../auth/instructorAuth'
import type { GameDefinition } from '../GameDefinition'

// Registered at module load so Firebase CLI knows this function needs the secret.
// All games use 'CLASSROOM_CALLBACK_SECRET' as the secret name in their own Firebase project.
const classroomCallbackSecret = defineSecret('CLASSROOM_CALLBACK_SECRET')

/**
 * Returns an onCall function that fetches the classroom enrollment roster and
 * pre-populates participant docs so the instructor sees enrolled students immediately.
 *
 * Merge rule: docs that already have a role (student self-joined) are never touched.
 * Only creates new rows or refreshes name/external_id on existing role-less rows.
 * No deletions. Idempotent.
 *
 * Call data (emulator): { _dev: { game_instance_id, roster_url?, callback_secret? } }
 * Call data (production): Bearer token or { token: "<instructor JWT>" }
 * Returns: { ok: true, synced, skipped }
 */
export function makeSyncRoster(def: GameDefinition) {
  return onCall(
    { cors: def.corsOrigins, secrets: [classroomCallbackSecret] },
    async (request) => {
      const data = request.data as Record<string, unknown>
      const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
      const authHeader = request.rawRequest.headers.authorization as string | undefined

      const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

      const devData =
        isEmulator && data._dev != null ? (data._dev as Record<string, unknown>) : null
      const rosterUrl =
        (devData?.roster_url as string | undefined) ?? process.env.CLASSROOM_ROSTER_URL ?? ''
      const callbackSecret =
        (devData?.callback_secret as string | undefined) ??
        process.env.CLASSROOM_CALLBACK_SECRET ??
        ''

      console.log('[syncRoster] config check', {
        has_roster_url: !!rosterUrl,
        has_callback_secret: !!callbackSecret,
        game_instance_id: gameInstanceId,
      })

      if (!rosterUrl || !callbackSecret) {
        console.error(
          '[syncRoster] missing config: CLASSROOM_ROSTER_URL or CLASSROOM_CALLBACK_SECRET not set',
        )
        throw new HttpsError('internal', 'Classroom roster not configured')
      }

      try {
        const rosterRes = await fetch(rosterUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${callbackSecret}`,
          },
          body: JSON.stringify({ game_instance_id: gameInstanceId }),
        })

        console.log('[syncRoster] classroom response status:', rosterRes.status)

        if (!rosterRes.ok) {
          const errText = await rosterRes.text().catch(() => '')
          console.error('[syncRoster] classroom error response:', {
            status: rosterRes.status,
            body: errText,
          })
          let errMsg: string | undefined
          try {
            errMsg = (JSON.parse(errText) as Record<string, unknown>).error as string | undefined
          } catch {
            /* not JSON */
          }
          throw new HttpsError(
            'unavailable',
            `Classroom roster error: ${errMsg ?? (errText || String(rosterRes.status))}`,
          )
        }

        const { participants } = (await rosterRes.json()) as {
          participants: Array<{
            participant_id: string
            name: string
            external_id: string | null
          }>
        }

        if (participants.length === 0) {
          return { ok: true as const, synced: 0, skipped: 0 }
        }

        const db = admin.firestore()
        const instanceRef = db.collection('game_instances').doc(gameInstanceId)
        const participantRefs = participants.map(p =>
          instanceRef.collection('participants').doc(p.participant_id),
        )

        const snaps = await db.getAll(...participantRefs)

        const batch = db.batch()
        let synced = 0
        let skipped = 0

        for (let i = 0; i < participants.length; i++) {
          const snap = snaps[i]
          const p = participants[i]
          const existing = snap.data()

          if (existing?.role) {
            skipped++
            continue
          }

          if (snap.exists) {
            batch.update(snap.ref, { name: p.name, external_id: p.external_id ?? null })
          } else {
            batch.set(snap.ref, {
              participant_id: p.participant_id,
              game_instance_id: gameInstanceId,
              name: p.name,
              external_id: p.external_id ?? null,
              prep_status: 'not_started',
            })
          }
          synced++
        }

        await instanceRef.set({ game_instance_id: gameInstanceId }, { merge: true })
        if (synced > 0) await batch.commit()

        console.log(
          `[syncRoster] synced=${synced} skipped=${skipped} for instance ${gameInstanceId}`,
        )
        return { ok: true as const, synced, skipped }
      } catch (err) {
        if (err instanceof HttpsError) throw err
        console.error(
          '[syncRoster] unexpected error:',
          err instanceof Error ? err.stack : JSON.stringify(err),
        )
        throw new HttpsError('internal', 'Internal error')
      }
    },
  )
}
