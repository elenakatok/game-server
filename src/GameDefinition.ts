import type { RoleConfig, OutcomeSchema, Outcome } from '@mygames/game-engine'

// KCQuestion and PrepQuestion are not yet in @mygames/game-engine.
// TODO BU-3: relocate these to @mygames/game-engine (or @mygames/game-ui) once the KC flow is extracted.

/** Stable role identity — an alias for string matching game-engine's role key convention. */
export type RoleKey = string

export type MCOption = { value: string; label: string }

export type KCQuestion = {
  field: string
  prompt: string
  options: MCOption[]
  /** Role key that sees this question, or 'all' for every participant. */
  role_target: string | 'all'
  /** Counted toward the KC score when true. */
  graded: boolean
  correct_value: string
  /** Shown after submission. Must be safe to display regardless of shuffle order. */
  explanation: string
}

export type PrepQuestion = {
  field: string
  type: 'text' | 'number' | 'mc'
  prompt: string
  placeholder?: string
  role_target: string | 'all'
  options?: MCOption[]
  order?: number
}

export interface GameDefinition {
  // ── identity & roles ──────────────────────────────────────────────────────
  game_id: string
  roles: RoleConfig
  /** 'cost' roles are negated before z-scoring so higher cost = worse outcome. */
  scoreSense: Record<RoleKey, 'value' | 'cost'>
  /** Players per role in a base group (e.g. { wm: 2, hb: 2 }). */
  composition: Record<RoleKey, number>
  /** distribute-extras ceiling per role; set large to mean "no cap". */
  perRoleCap: number

  // ── outcome & scoring ─────────────────────────────────────────────────────
  outcomeSchema: OutcomeSchema
  /** The only bespoke function each game supplies. null outcome = walk-away (returns 0). */
  computeRawScore: (role: RoleKey, outcome: Outcome | null) => number
  /** Walk-away reservation values per role (surplus games only, e.g. Winemaster). */
  reservations?: Record<RoleKey, number>

  // ── content ───────────────────────────────────────────────────────────────
  content: {
    /** Private role PDF + optional shared public PDF, keyed by role. */
    infoPDFs: Record<RoleKey, { private: string; public?: string }>
    worksheets?: Record<RoleKey, string>
    kcQuestions: KCQuestion[]
    prepQuestions: PrepQuestion[]
    /** Scenario background text injected into the student flow. Shape finalized at BU-2. */
    scenarioText: Record<string, string>
  }

  // ── classroom contract ────────────────────────────────────────────────────
  /** Secret Manager secret ID for the classroom callback (e.g. 'winemaster_v1'). */
  classroom: { callbackSecretId: string }

  // ── dashboard (UI only — type refined in @mygames/game-ui at BU-1) ────────
  dashboardColumns?: unknown
}
