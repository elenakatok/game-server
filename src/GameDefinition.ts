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

/**
 * Full runtime shape of a prep/KC question stored in config/main.
 * TODO BU-3: relocate to @mygames/game-engine once the KC flow is extracted.
 */
export type PrepTextQuestion = {
  field:       string
  type:        'text' | 'number' | 'mc'
  system:      boolean
  prompt:      string
  placeholder: string
  order:       number
  hidden:      boolean
  deletable:   boolean
  options?:    MCOption[]
  category:    'knowledge_check' | 'preparation' | 'debrief'
  format:      'multiple_choice' | 'number' | 'text'
  grading?:    'static' | 'assigned_role'
  correct_value?: string
  /** 'all' = every role; any other string = a specific role key. Legacy 'both' normalised to 'all' on parse. */
  role_target: string
  explanation?: string
}

/**
 * Declares a single editable field in game_instances/{id}/config/main.
 * The factory reads/writes/validates each field according to its declared kind.
 */
export type ConfigFieldDef =
  | { key: string; kind: 'string';      default: string }
  | { key: string; kind: 'positiveInt'; default: number }
  | { key: string; kind: 'url';         default: string }

export interface GameDefinition {
  // ── identity & roles ──────────────────────────────────────────────────────
  game_id: string
  roles: RoleConfig
  /** 'cost' roles are negated before z-scoring so higher cost = worse outcome. */
  scoreSense: Record<RoleKey, 'value' | 'cost'>
  /** Players per role in a base group (e.g. { wm: 2, hb: 2 }). */
  composition: Record<RoleKey, number>
  /**
   * distribute-extras ceiling per role per group.
   * Absent → factory uses eligible.length at runtime ("no cap" — place every extra).
   */
  perRoleCap?: number

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
  /**
   * Number of failed confirmation rounds before a group is declared deadlocked.
   * Absent → factory defaults to 5.
   */
  deadlockThreshold?: number

  // ── deployment ────────────────────────────────────────────────────────────
  /** Allowed CORS origins for the game's Cloud Functions (e.g. ['https://winemaster.mygames.live']). */
  corsOrigins: string[]

  // ── settings (BU-S2) ─────────────────────────────────────────────────────
  /**
   * Declares the game-specific config fields the Settings page can read and write.
   * Absent → only prep_text_questions is served by makeGetGameConfig / makeUpdateGameConfig.
   */
  configFields?: ConfigFieldDef[]

  /**
   * Default + system prep/KC questions for instances with no stored prep_text_questions yet.
   * Questions with system:true are re-injected on every read even if missing from the stored list.
   * Absent → no defaults are injected; the stored array is returned as-is.
   */
  prepDefaults?: PrepTextQuestion[]

  // ── dashboard (UI only — type refined in @mygames/game-ui at BU-1) ────────
  dashboardColumns?: unknown
}
