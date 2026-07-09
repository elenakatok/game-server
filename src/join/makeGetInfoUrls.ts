import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractStudentOnCallIds } from '../auth/studentOnCallAuth'
import type { GameDefinition } from '../GameDefinition'
import { readConfigField } from '../config/configField'
import { clampRoundIndex } from '../flow/roundOutcome'

/**
 * Returns the info-page link URLs for the authenticated student's role.
 * Never exposes another role's URLs — only the student's own role is served.
 *
 * Auth: Firebase student Bearer token, classroom JWT, or emulator _test bypass.
 *
 * Returns:
 *   { ok: true, roleLabel, links: [{ label, url }], publicLink: { label, url } | null }
 *
 * url is the resolved config value (falls back to the declared configField default).
 */
export function makeGetInfoUrls(def: GameDefinition) {
  return onCall({ cors: def.corsOrigins }, async (request) => {
    const data = request.data as Record<string, unknown>
    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
    const authHeader = request.rawRequest.headers.authorization as string | undefined

    const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmulator, authHeader)

    const db = admin.firestore()
    const instanceRef = db.collection('game_instances').doc(gameInstanceId)
    // Staged games (def.rounds present) also read the instance doc for current_round so
    // phase-aware role-info can serve the round's links. One-shot games skip that read
    // entirely → the flat behavior below is byte-for-byte identical.
    const isStaged = Array.isArray(def.rounds) && def.rounds.length > 0
    const [participantSnap, configSnap, instanceSnap] = await Promise.all([
      instanceRef.collection('participants').doc(participantId).get(),
      instanceRef.collection('config').doc('main').get(),
      isStaged ? instanceRef.get() : Promise.resolve(null),
    ])

    const participantRole = (participantSnap.data() ?? {}).role as string | undefined
    if (!participantRole) throw new HttpsError('unavailable', 'Role not yet assigned.')

    const cfg = (configSnap.data() ?? {}) as Record<string, unknown>

    const roleEntry = def.roles.roles.find(r => r.key === participantRole)
    const roleLabel = roleEntry?.label ?? participantRole

    function resolveUrl(key: string): string {
      const fieldDef = def.configFields?.find(f => f.key === key)
      return fieldDef
        ? (readConfigField(fieldDef, cfg[key]) as string)
        : (typeof cfg[key] === 'string' ? (cfg[key] as string) : '')
    }

    // Phase-aware links (Option-1 derive): if the game declares roleInfoLinksByRound and
    // has an entry for the instance's current round, use it; else fall back to flat.
    let roleLinkSet = def.roleInfoLinks ?? []
    if (isStaged && def.roleInfoLinksByRound) {
      const rounds = def.rounds as string[]
      const roundId = rounds[clampRoundIndex(rounds.length, instanceSnap?.data()?.['current_round'])]
      const byRound = def.roleInfoLinksByRound[roundId]
      if (byRound) roleLinkSet = byRound
    }

    const roleDef = roleLinkSet.find(r => r.roleKey === participantRole)
    const links = (roleDef?.links ?? []).map(({ key, label }) => ({
      label,
      url: resolveUrl(key) || null,
    }))

    let publicLink: { label: string; url: string } | null = null
    if (def.publicInfoLinkKey) {
      const url = resolveUrl(def.publicInfoLinkKey)
      if (url) publicLink = { label: 'Public Information', url }
    }

    return { ok: true, roleLabel, links, publicLink }
  })
}
