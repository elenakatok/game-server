// Shared plumbing for the online callables. Every factory here takes the same
// context, so wiring a game up is one object rather than eight argument lists.

import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import type { GameDefinition } from '../GameDefinition'
import type { GroupDocAdapter } from './groupDocAdapter'
import type { OnlineDefinition } from './types'

export interface OnlineContext {
  def: GameDefinition
  online: OnlineDefinition
  adapter: GroupDocAdapter
}

export const isEmu = (): boolean => process.env.FUNCTIONS_EMULATOR === 'true'

export const authHeaderOf = (req: CallableRequest): string | undefined =>
  req.rawRequest.headers.authorization as string | undefined

export const corsOf = (ctx: OnlineContext) => ({ cors: ctx.def.corsOrigins })

export const instanceRef = (gameInstanceId: string) =>
  admin.firestore().collection('game_instances').doc(gameInstanceId)

export const groupsRef = (gameInstanceId: string) => instanceRef(gameInstanceId).collection('groups')

export const participantsRef = (gameInstanceId: string) =>
  instanceRef(gameInstanceId).collection('participants')

/** Required non-empty string argument. */
export function requireArg(data: Record<string, unknown>, key: string): string {
  const v = String(data[key] ?? '')
  if (!v) throw new HttpsError('invalid-argument', `${key} required`)
  return v
}

/**
 * Stable 1-based group numbers by sorted group id. Every online read path uses this
 * SAME ordering so the number a student is told matches the number on the dashboard
 * and in the report — the numbers are cosmetic, but a mismatch between two screens
 * is a support question.
 */
export function groupNumbering(groupIds: readonly string[]): Map<string, number> {
  return new Map([...groupIds].sort((a, b) => a.localeCompare(b)).map((id, i) => [id, i + 1]))
}

/** display_name the student chose wins; then the roster name; then the raw id. */
export function displayNameOf(data: Record<string, unknown>, participantId: string): string {
  const chosen = data['display_name']
  if (typeof chosen === 'string' && chosen.trim()) return chosen
  const roster = data['name']
  if (typeof roster === 'string' && roster.trim()) return roster
  return participantId
}

export function emailOf(data: Record<string, unknown>): string | null {
  const e = data['email']
  return typeof e === 'string' && e.trim() ? e.trim() : null
}

/** Fisher–Yates. Genuinely random — grouping is not meant to be reproducible. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Turn a rejection from the pure seat ops into the right HttpsError. */
export function throwSeatRejection(reason: string): never {
  throw new HttpsError('failed-precondition', reason)
}
