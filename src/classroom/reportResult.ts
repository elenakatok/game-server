import * as https from 'https'
import * as http from 'http'
import { isValidRole, type RoleConfig } from '@mygames/game-engine'

export type GameResult = {
  game_instance_id: string
  participant_id: string
  status: 'completed' | 'no_show' | 'partial' | 'excluded'
  role: string | null
  raw_score?: number | null
  normalized_score: number | null
  knowledge_check_score: number | null
  details: Record<string, unknown>
}

/**
 * Builds the classroom-bound GameResult for one participant from its score fields.
 * SINGLE source of the push payload shape — used by BOTH finalizeInstance (from the
 * scores it just computed, in-memory, race-free) and pushResultsToClassroom (re-read
 * re-delivery path) so the two can never drift.
 *
 * Contract (unchanged): gate is the caller's (never drop on role here); role is normalised
 * to null for any non-valid role; status = completed when raw_score present, else no_show;
 * raw_score is intentionally NOT included in the payload (gradebook contract).
 */
export function toGameResult(
  gameInstanceId: string,
  participantId: string,
  data: Record<string, unknown>,
  roles: RoleConfig,
): GameResult {
  const rawRole = data['role']
  const role = typeof rawRole === 'string' && isValidRole(roles, rawRole) ? rawRole : null
  const status: GameResult['status'] = data['raw_score'] != null ? 'completed' : 'no_show'
  return {
    game_instance_id: gameInstanceId,
    participant_id: participantId,
    status,
    role,
    normalized_score: (data['normalized_score'] ?? null) as number | null,
    knowledge_check_score: (data['knowledge_check_score'] ?? null) as number | null,
    details: (data['details'] ?? {}) as Record<string, unknown>,
  }
}

export type FailedPush = { participant_id: string; reason: string }

export type PushSummary = {
  total: number
  succeeded: number
  failed: FailedPush[]
}

type ReportFn = (result: GameResult, callbackUrl: string, callbackSecret: string) => Promise<void>

/**
 * POSTs a single GameResult to the classroom callback URL.
 * No-ops silently when callbackUrl or callbackSecret is empty — standalone mode.
 */
export async function reportResult(
  result: GameResult,
  callbackUrl: string,
  callbackSecret: string,
): Promise<void> {
  if (!callbackUrl || !callbackSecret) return

  const body = JSON.stringify(result)
  const url = new URL(callbackUrl)
  const isHttps = url.protocol === 'https:'
  const lib = isHttps ? https : http

  await new Promise<void>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${callbackSecret.trim()}`,
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve()
        } else {
          reject(new Error(`Classroom callback returned HTTP ${res.statusCode}`))
        }
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  const match = /HTTP (\d+)/.exec(err.message)
  if (!match) return true // network / timeout — transient
  return parseInt(match[1], 10) >= 500
}

async function pushWithRetry(
  result: GameResult,
  callbackUrl: string,
  callbackSecret: string,
  reportFn: ReportFn,
  retryDelays: readonly number[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const maxAttempts = retryDelays.length + 1
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt - 1]))
    }
    try {
      await reportFn(result, callbackUrl, callbackSecret)
      return { ok: true }
    } catch (err) {
      const e = err as Error & { code?: string }
      console.error('[push] attempt', attempt + 1, 'failed for', result.participant_id,
        '| message:', e.message, '| code:', e.code ?? '(none)', '| stack:', e.stack ?? '(none)')
      if (!isRetryable(err)) {
        return { ok: false, reason: e.message }
      }
      lastErr = err
    }
  }
  const e = lastErr as Error & { code?: string }
  return { ok: false, reason: e instanceof Error ? e.message : String(lastErr) }
}

/**
 * Pushes a batch of GameResult records to the classroom, one at a time.
 * A failure for one participant does not stop the others.
 * Retries on transient errors (network, HTTP 5xx); fails fast on HTTP 4xx.
 *
 * Pass reportFn and retryDelays=[0,0] in tests to eliminate real HTTP and backoff.
 */
export async function dispatchResults(
  records: GameResult[],
  callbackUrl: string,
  callbackSecret: string,
  reportFn: ReportFn = reportResult,
  retryDelays: readonly number[] = [500, 1000],
): Promise<PushSummary> {
  let succeeded = 0
  const failed: FailedPush[] = []

  for (const record of records) {
    const outcome = await pushWithRetry(record, callbackUrl, callbackSecret, reportFn, retryDelays)
    if (outcome.ok) {
      succeeded++
    } else {
      failed.push({ participant_id: record.participant_id, reason: outcome.reason })
    }
  }

  return { total: records.length, succeeded, failed }
}
