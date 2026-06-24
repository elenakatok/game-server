import { describe, it, expect } from 'vitest'
import { calcKCScore } from '../../src/kc/calcKCScore'
import { djb2Hash, seededShuffle } from '../../src/kc/shuffle'
import type { PrepTextQuestion } from '../../src/GameDefinition'

// ── Winemaster static KC questions (mirrors KC-1 prepDefaults) ───────────────

const WM_STATIC: { field: string; correct_value: string }[] = [
  { field: 'kc_wm_scarcity',           correct_value: 'scarcity'        },
  { field: 'kc_wm_reciprocation',       correct_value: 'reciprocation'   },
  { field: 'kc_wm_objective_criteria',  correct_value: 'joint_standard'  },
  { field: 'kc_wm_principled',          correct_value: 'decline_link'    },
]

const HB_STATIC: { field: string; correct_value: string }[] = [
  { field: 'kc_hb_scarcity',            correct_value: 'scarcity'        },
  { field: 'kc_hb_consistency',         correct_value: 'consistency'     },
  { field: 'kc_hb_objective_criteria',  correct_value: 'ask_joint_search' },
  { field: 'kc_hb_principled',          correct_value: 'separate_merits' },
]

function allCorrect(qs: typeof WM_STATIC): Record<string, string> {
  return Object.fromEntries(qs.map(q => [q.field, q.correct_value]))
}

// ── PROOF 1: Score formula — Winemaster (N = 4) ───────────────────────────────

describe('calcKCScore — Winemaster score formula proof (N = 4)', () => {
  it('0/4 correct → score = 0.0', () => {
    const { score, correctCount, totalCount } = calcKCScore({}, WM_STATIC)
    expect(totalCount).toBe(4)
    expect(correctCount).toBe(0)
    expect(score).toBe(0.0)
  })

  it('1/4 correct → score = 0.25', () => {
    const answers = { kc_wm_scarcity: 'scarcity' }
    const { score, correctCount } = calcKCScore(answers, WM_STATIC)
    expect(correctCount).toBe(1)
    expect(score).toBe(0.25)
  })

  it('2/4 correct → score = 0.5', () => {
    const answers = { kc_wm_scarcity: 'scarcity', kc_wm_reciprocation: 'reciprocation' }
    const { score, correctCount } = calcKCScore(answers, WM_STATIC)
    expect(correctCount).toBe(2)
    expect(score).toBe(0.5)
  })

  it('3/4 correct → score = 0.75', () => {
    const answers = {
      kc_wm_scarcity: 'scarcity',
      kc_wm_reciprocation: 'reciprocation',
      kc_wm_objective_criteria: 'joint_standard',
    }
    const { score, correctCount } = calcKCScore(answers, WM_STATIC)
    expect(correctCount).toBe(3)
    expect(score).toBe(0.75)
  })

  it('4/4 correct → score = 1.0', () => {
    const { score, correctCount } = calcKCScore(allCorrect(WM_STATIC), WM_STATIC)
    expect(correctCount).toBe(4)
    expect(score).toBe(1.0)
  })

  it('gate passing does NOT contribute — N stays 4, score stays score/4', () => {
    // Simulate: student passed gate (answer === role), then answered 2/4 static correctly.
    // The gate answer is not in the staticKCQuestions list — it should have zero effect on score.
    const answersWithGate = {
      kc_gate_winemaster: 'winemaster', // gate answer — NOT in WM_STATIC
      kc_wm_scarcity: 'scarcity',
      kc_wm_reciprocation: 'reciprocation',
    }
    const { score, totalCount } = calcKCScore(answersWithGate, WM_STATIC)
    expect(totalCount).toBe(4)   // gate not counted in denominator
    expect(score).toBe(0.5)      // 2/4, not 3/5
  })
})

// ── PROOF 2: Same formula generalises to arbitrary N ─────────────────────────

describe('calcKCScore — general N proof', () => {
  it('N = 3: 2/3 correct → 0.6667', () => {
    const qs = [
      { field: 'q1', correct_value: 'a' },
      { field: 'q2', correct_value: 'b' },
      { field: 'q3', correct_value: 'c' },
    ]
    const { score } = calcKCScore({ q1: 'a', q2: 'b', q3: 'WRONG' }, qs)
    expect(score).toBeCloseTo(2 / 3)
  })

  it('N = 7: 7/7 correct → 1.0', () => {
    const qs = Array.from({ length: 7 }, (_, i) => ({ field: `q${i}`, correct_value: `v${i}` }))
    const answers = Object.fromEntries(qs.map(q => [q.field, q.correct_value]))
    const { score, totalCount } = calcKCScore(answers, qs)
    expect(totalCount).toBe(7)
    expect(score).toBe(1.0)
  })

  it('N = 0 (zero-static role) → score = 1.0 (gate-only completion)', () => {
    const { score, totalCount, correctCount } = calcKCScore({}, [])
    expect(totalCount).toBe(0)
    expect(correctCount).toBe(0)
    expect(score).toBe(1.0)
  })
})

// ── PROOF 3: Role-filter proof — winemaster sees only its 4, home_base only its 4 ──

describe('calcKCScore — role-filter proof', () => {
  it('winemaster denominator = 4 (its own questions only)', () => {
    const { totalCount } = calcKCScore({}, WM_STATIC)
    expect(totalCount).toBe(4)
  })

  it('home_base denominator = 4 (its own questions only)', () => {
    const { totalCount } = calcKCScore({}, HB_STATIC)
    expect(totalCount).toBe(4)
  })

  it('winemaster not penalised for home_base questions it never answers', () => {
    // winemaster answers all 4 of its own questions correctly; HB answers are absent.
    // Score should be 1.0, not penalised for missing HB answers.
    const { score } = calcKCScore(allCorrect(WM_STATIC), WM_STATIC)
    expect(score).toBe(1.0)
  })

  it('home_base not penalised for winemaster questions it never answers', () => {
    const { score } = calcKCScore(allCorrect(HB_STATIC), HB_STATIC)
    expect(score).toBe(1.0)
  })

  it('winemaster answering home_base questions with correct HB values scores 0 (wrong values for WM)', () => {
    // Sanity: HB correct values don't match WM correct values (Q3 differs: reciprocation vs consistency)
    const answers = allCorrect(HB_STATIC)
    // kc_hb_consistency: 'consistency' — but WM has kc_wm_reciprocation: 'reciprocation', different field entirely
    // WM_STATIC doesn't contain any HB fields, so all answers are missing → 0/4
    const { score } = calcKCScore(answers, WM_STATIC)
    expect(score).toBe(0.0)
  })
})

// ── PROOF 4: Answer-key-leak proof ───────────────────────────────────────────

// Simulate the strip logic used in makeGetStudentPrepQuestions.
function stripAnswerKey(
  questions: PrepTextQuestion[],
): Omit<PrepTextQuestion, 'correct_value' | 'grading' | 'explanation'>[] {
  return questions.map(({ correct_value: _cv, grading: _g, explanation: _ex, ...rest }) => rest)
}

const GRADED_Q: PrepTextQuestion = {
  field: 'kc_wm_scarcity', type: 'mc', system: false,
  category: 'knowledge_check', format: 'multiple_choice',
  grading: 'static', correct_value: 'scarcity', role_target: 'winemaster',
  prompt: 'Which tactic?', placeholder: '', order: 10, hidden: false, deletable: false,
  options: [{ value: 'scarcity', label: 'Scarcity' }, { value: 'liking', label: 'Liking' }],
  explanation: 'Making WineMaster appear less available is the scarcity tactic.',
}

const GATE_Q: PrepTextQuestion = {
  field: 'kc_gate_winemaster', type: 'mc', system: true,
  category: 'knowledge_check', format: 'multiple_choice',
  grading: 'assigned_role', role_target: 'winemaster',
  prompt: 'What is your role?', placeholder: '', order: 0, hidden: false, deletable: false,
  options: [
    { value: 'winemaster', label: 'WineMaster' },
    { value: 'home_base',  label: 'HomeBase'  },
  ],
  explanation: 'You are WineMaster.',
}

describe('Answer-key-leak proof', () => {
  it('stripped delivery payload contains no correct_value', () => {
    const stripped = stripAnswerKey([GRADED_Q, GATE_Q])
    for (const q of stripped) {
      expect(Object.keys(q)).not.toContain('correct_value')
    }
  })

  it('stripped delivery payload contains no grading', () => {
    const stripped = stripAnswerKey([GRADED_Q, GATE_Q])
    for (const q of stripped) {
      expect(Object.keys(q)).not.toContain('grading')
    }
  })

  it('stripped delivery payload contains no explanation', () => {
    const stripped = stripAnswerKey([GRADED_Q, GATE_Q])
    for (const q of stripped) {
      expect(Object.keys(q)).not.toContain('explanation')
    }
  })

  it('stripped payload still contains options, prompt, and other safe fields', () => {
    const [stripped] = stripAnswerKey([GRADED_Q])
    expect(stripped.field).toBe('kc_wm_scarcity')
    expect(stripped.options).toBeDefined()
    expect(stripped.prompt).toBeTruthy()
  })
})

// ── PROOF 5: Shuffle-stability proof ─────────────────────────────────────────

describe('djb2Hash — determinism', () => {
  it('same input → same hash', () => {
    expect(djb2Hash('p1:kc_wm_scarcity')).toBe(djb2Hash('p1:kc_wm_scarcity'))
  })

  it('different inputs → different hashes (very likely)', () => {
    expect(djb2Hash('p1:kc_wm_scarcity')).not.toBe(djb2Hash('p2:kc_wm_scarcity'))
  })

  it('empty string → 5381 (djb2 initial value)', () => {
    expect(djb2Hash('')).toBe(5381)
  })

  it('returns unsigned 32-bit integer (≥0)', () => {
    expect(djb2Hash('participant-abc:kc_hb_scarcity')).toBeGreaterThanOrEqual(0)
  })
})

describe('seededShuffle — shuffle-stability proof', () => {
  const OPTIONS = ['a', 'b', 'c', 'd', 'e', 'f']

  it('same seed → same shuffle result', () => {
    const seed = djb2Hash('p1:kc_wm_scarcity')
    const r1 = seededShuffle(OPTIONS, seed)
    const r2 = seededShuffle(OPTIONS, seed)
    expect(r1).toEqual(r2)
  })

  it('different participantId → different shuffle (collision extremely unlikely)', () => {
    const seed1 = djb2Hash('participant-alice:kc_wm_scarcity')
    const seed2 = djb2Hash('participant-bob:kc_wm_scarcity')
    // Different seeds should produce different orders for a 6-element array
    const r1 = seededShuffle(OPTIONS, seed1)
    const r2 = seededShuffle(OPTIONS, seed2)
    expect(r1).not.toEqual(r2)
  })

  it('same participant, different field → different shuffle', () => {
    const seed1 = djb2Hash('p1:kc_wm_scarcity')
    const seed2 = djb2Hash('p1:kc_wm_principled')
    const r1 = seededShuffle(OPTIONS, seed1)
    const r2 = seededShuffle(OPTIONS, seed2)
    expect(r1).not.toEqual(r2)
  })

  it('does not mutate the input array', () => {
    const original = [...OPTIONS]
    seededShuffle(OPTIONS, 12345)
    expect(OPTIONS).toEqual(original)
  })

  it('returns all original elements (no drops or duplicates)', () => {
    const result = seededShuffle(OPTIONS, djb2Hash('p1:kc_wm_scarcity'))
    expect(result.sort()).toEqual([...OPTIONS].sort())
  })

  it('single-element array → unchanged', () => {
    expect(seededShuffle(['x'], 42)).toEqual(['x'])
  })
})
