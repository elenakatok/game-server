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
  type:        'text' | 'number' | 'mc' | 'likert'
  system:      boolean
  prompt:      string
  placeholder: string
  order:       number
  hidden:      boolean
  deletable:   boolean
  /** For 'mc': the answer choices. For 'likert': the ordered rating points (value '1'..'N'); the
   *  first and last option labels are the scale anchors (e.g. 'Very poor' … 'Very good'). */
  options?:    MCOption[]
  category:    'knowledge_check' | 'preparation' | 'debrief'
  format:      'multiple_choice' | 'number' | 'text' | 'likert'
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
  /**
   * Opt-in remainder policy (Adirondacks). After all ideal base groups form, if the
   * leftover still holds ≥ its count of EVERY named role, one alternate-composition
   * group is pulled (at most once) before extras are absorbed. The matching guard is
   * also relaxed so an instance that can form ONLY a remnant group (no full base group)
   * still matches. Absent → no second-pass group; matching is unchanged.
   * Example (Adirondacks): { composition: { gpp:1, ala:1, flp:1, fcc:1, governor:1, atb:1 } }.
   */
  remnantGroup?: { composition: Record<RoleKey, number> }

  /**
   * Ordered list of round ids for a multi-round (staged) game, e.g. Baxter:
   * ['1978','1983','1985']. ABSENT → one-shot game, unchanged behavior — no round
   * state, no proceed gate, and getRoster reports rounds:null. Declaring rounds is
   * purely additive: it enables the class-level current_round + makeAdvanceRound
   * proceed gate. Round 1 is the game's existing single-outcome round.
   */
  rounds?: string[]

  // ── outcome & scoring ─────────────────────────────────────────────────────
  outcomeSchema: OutcomeSchema
  /**
   * Optional per-round outcome schemas for a multi-round game whose rounds negotiate
   * DIFFERENT contracts (e.g. Baxter 1983 is a single continuous wage, not the 1978
   * six-issue contract). Keyed by round id (a value in `rounds`). The submit flow
   * validates a round's lead outcome against `roundOutcomeSchemas[roundId]` when present,
   * else falls back to `outcomeSchema`. ABSENT, or a round id not in the map → the flow
   * validates against `outcomeSchema` exactly as before (byte-identical for one-shot games
   * and for every round the map does not override, including round 1).
   */
  roundOutcomeSchemas?: Record<string, OutcomeSchema>

  /**
   * How a group's outcome is ratified after the lead reports it (opt-in; default 'unanimous').
   *   'unanimous' — the EXISTING accept/redo loop: every present non-lead confirms; a reject
   *                 RESETS the round (lead re-reports) up to deadlockThreshold, then deadlocks.
   *   'ultimatum' — max-attempts = 1: the receiver gets ONE decision. All accept → deal; ANY
   *                 reject → immediate TERMINAL no-deal for both parties (walk-away → the round's
   *                 existing no-deal handling). No reset, no redo, no second offer, no counter.
   * This is the WHOLE-GAME default; `roundOutcomeMechanics` overrides it per round.
   * Absent → 'unanimous' (byte-identical to the existing behavior for every current game).
   */
  outcomeMechanic?: 'unanimous' | 'ultimatum'
  /**
   * Per-round override of `outcomeMechanic`, keyed by round id (a value in `rounds`). E.g.
   * Baxter: { '1978': 'ultimatum', '1985': 'ultimatum' } — 1983 keeps the default accept/redo
   * loop. A round id absent from the map falls back to `outcomeMechanic` then 'unanimous'.
   * ABSENT → every round uses `outcomeMechanic` (byte-identical for one-shot games).
   */
  roundOutcomeMechanics?: Record<string, 'unanimous' | 'ultimatum'>
  /**
   * The only bespoke function each game supplies. null outcome = walk-away (returns 0).
   * configData: the current contents of config/main (may be empty on first run).
   * The factory reads config/main before calling this, then passes it via the scorer closure.
   */
  computeRawScore: (role: RoleKey, outcome: Outcome | null, configData?: Record<string, unknown>) => number
  /**
   * Optional breakdown of the scoring intermediate.
   * When present, makeFinalizeInstance additionally writes `value_or_cost` to each participant doc.
   * Absent → finalization is byte-for-byte identical to the existing behavior (backwards-compatible).
   */
  computeScoreBreakdown?: (role: RoleKey, outcome: Outcome | null, configData?: Record<string, unknown>) => { value_or_cost: number; raw_score: number }
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

  // ── student info page (BU-2b) ─────────────────────────────────────────────
  /**
   * Per-role info link declarations for the student info page.
   * Each entry maps a role key to its list of links; link keys must appear in configFields.
   * Used by makeGetInfoUrls to return only the student's own role's URLs (never the other roles').
   */
  roleInfoLinks?: Array<{ roleKey: string; links: Array<{ key: string; label: string }> }>

  /**
   * Config key for the shared public info URL shown to all roles on the info page.
   * Absent → no public link section is rendered. The key must appear in configFields.
   */
  publicInfoLinkKey?: string

  // ── dashboard (UI only — type refined in @mygames/game-ui at BU-1) ────────
  dashboardColumns?: unknown
}
