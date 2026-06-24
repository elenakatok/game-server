/**
 * Computes the KC score from a student's answers to graded static questions.
 *
 * Score = correctStatic / N, where N = count of role-filtered grading:'static' questions.
 * The role gate (grading:'assigned_role') is NOT part of this score — not in numerator,
 * not in denominator. Range: 0.0 (all wrong) – 1.0 (all correct).
 * If N === 0 (no graded static questions for this role), score = 1.0 (gate-only completion).
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
