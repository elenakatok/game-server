/**
 * Computes the KC score from a student's answers to graded static questions.
 *
 * Score = correctStatic / N, where N = count of role-filtered grading:'static' questions.
 * The role gate (grading:'assigned_role') is NOT part of this score — not in numerator,
 * not in denominator. Range: 0.0 (all wrong) – 1.0 (all correct).
 * If N === 0 (no graded static questions for this role), score = 1.0 (gate-only completion).
 *
 * ⚠⚠ THE N === 0 BRANCH IS A TRAP FOR ANY CALLER THAT CAN HAVE AN EMPTY GRADED SET.
 *
 * 1.0 is the right answer for the case this was written for — a NEGOTIATION game whose
 * role has only a gate question, where "completed the gate" IS full marks. It is the wrong
 * answer for a SINGLE-PLAYER game whose instructor hid every graded question, or whose
 * knowledge check is one free-text addition: there the student was never asked anything and
 * a stored 1.0 is a perfect score they did not earn, pushed on to the gradebook.
 *
 * ⚠ THIS FUNCTION'S BEHAVIOUR IS DELIBERATELY UNCHANGED. Thirteen negotiation games in
 * their own Firebase projects depend on it through `makeSubmitKnowledgeCheck` and
 * `makeSubmitStaticKnowledgeCheckQuestion`, and two of those pass an empty set ON PURPOSE
 * to mean "gate-only, full marks". Callers that need the other answer take
 * `kcScoreOrNull` below instead. Do not "fix" this one.
 */
export function calcKCScore(
  answers: Record<string, string>,
  staticKCQuestions: ReadonlyArray<{ field: string; correct_value: string }>,
): { score: number; correctCount: number; totalCount: number } {
  const totalCount = staticKCQuestions.length
  const correctCount = staticKCQuestions.filter(q => answers[q.field] === q.correct_value).length
  const score = totalCount === 0 ? 1.0 : correctCount / totalCount
  return { score, correctCount, totalCount }
}

/**
 * The score to STORE when the graded set may legitimately be EMPTY — `null` rather than a
 * number.
 *
 * ⚠⚠ USE THIS, NOT `calcKCScore(...).score`, ANYWHERE AN INSTRUCTOR CAN REMOVE EVERY GRADED
 * QUESTION. That became possible the moment the single-player family's settings pages gained
 * a per-question `hidden` map (KC convergence spec §5): an instructor who unticks every
 * graded box, or whose check is a single free-text addition, produces a student with nothing
 * to be right or wrong about. `calcKCScore` answers that with 1.0 — see its note — and the
 * single-player `scoreAndRecord` path writes `knowledge_check_score` straight to the
 * gradebook, so the student is recorded at 100% on a check they were never asked.
 *
 * `null` is the honest value, and it is what every single-player consumer downstream already
 * handles: report.ts, scoring.ts and scoreAndRecord all read
 * `typeof x === 'number' ? x : null`.
 *
 * ⚠ ADDITIVE. Nothing that exists today calls this; it changes no current behaviour. It was
 * promoted here from `scorecard/questions.ts`, where it shipped locally in commit fb4a33d,
 * so that pd — and the four single-player games after it — cannot each re-derive the rule
 * and get it subtly different.
 */
export function kcScoreOrNull(
  answers: Record<string, string>,
  staticKCQuestions: ReadonlyArray<{ field: string; correct_value: string }>,
): number | null {
  if (staticKCQuestions.length === 0) return null
  return calcKCScore(answers, staticKCQuestions).score
}
