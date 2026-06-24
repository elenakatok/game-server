import type { MCOption, PrepTextQuestion } from '../GameDefinition'

export type { PrepTextQuestion }

/**
 * Parses a raw Firestore value into a validated PrepTextQuestion array.
 * Returns null if the input is not a valid array or any item fails shape validation.
 * Backward-compat: normalises legacy role_target 'both' → 'all'; infers format/category from type/field when absent.
 */
export function parsePrepTextQuestions(raw: unknown): PrepTextQuestion[] | null {
  if (!Array.isArray(raw)) return null
  if (raw.length > 50) return null

  const result: PrepTextQuestion[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null
    const q = item as Record<string, unknown>

    if (typeof q['field'] !== 'string') return null
    const field = q['field'] as string
    if (
      !field.startsWith('prep_') &&
      !field.startsWith('kc_') &&
      !field.startsWith('debrief_') &&
      field !== 'knowledge_check'
    ) return null

    if (typeof q['prompt']      !== 'string')                                  return null
    if (typeof q['placeholder'] !== 'string')                                  return null
    if (typeof q['order']       !== 'number' || !Number.isFinite(q['order']))  return null
    if (typeof q['hidden']      !== 'boolean')                                 return null
    if (typeof q['deletable']   !== 'boolean')                                 return null

    const type: 'text' | 'number' | 'mc' =
      q['type'] === 'number' ? 'number' : q['type'] === 'mc' ? 'mc' : 'text'
    const system: boolean = q['system'] === true

    let options: MCOption[] | undefined
    if (type === 'mc') {
      if (!Array.isArray(q['options'])) return null
      options = []
      for (const opt of q['options'] as unknown[]) {
        if (typeof opt !== 'object' || opt === null) return null
        const o = opt as Record<string, unknown>
        if (typeof o['value'] !== 'string' || typeof o['label'] !== 'string') return null
        options.push({ value: o['value'], label: o['label'] })
      }
    }

    const format: PrepTextQuestion['format'] =
      q['format'] === 'multiple_choice' ? 'multiple_choice'
      : q['format'] === 'number'        ? 'number'
      : q['format'] === 'text'          ? 'text'
      : type === 'mc'                   ? 'multiple_choice'
      : type === 'number'               ? 'number'
      : 'text'

    const category: PrepTextQuestion['category'] =
      q['category'] === 'knowledge_check' ? 'knowledge_check'
      : q['category'] === 'debrief'       ? 'debrief'
      : q['category'] === 'preparation'   ? 'preparation'
      : field === 'knowledge_check' || field.startsWith('kc_') ? 'knowledge_check'
      : field.startsWith('debrief_')      ? 'debrief'
      : 'preparation'

    const grading: PrepTextQuestion['grading'] =
      q['grading'] === 'static'         ? 'static'
      : q['grading'] === 'assigned_role' ? 'assigned_role'
      : undefined

    const correct_value: string | undefined =
      typeof q['correct_value'] === 'string' ? q['correct_value'] : undefined

    // Normalise legacy 'both' to 'all'; keep any other string (role key) as-is.
    const rawTarget = q['role_target']
    const role_target: string =
      rawTarget === 'both' ? 'all'
      : typeof rawTarget === 'string' ? rawTarget
      : 'all'

    const explanation: string | undefined =
      typeof q['explanation'] === 'string' ? q['explanation'] : undefined

    const parsed: PrepTextQuestion = {
      field,
      type,
      system,
      prompt:      q['prompt']      as string,
      placeholder: q['placeholder'] as string,
      order:       q['order']       as number,
      hidden:      q['hidden']      as boolean,
      deletable:   q['deletable']   as boolean,
      category,
      format,
      role_target,
    }
    if (options       !== undefined) parsed.options       = options
    if (grading       !== undefined) parsed.grading       = grading
    if (correct_value !== undefined) parsed.correct_value = correct_value
    if (explanation   !== undefined) parsed.explanation   = explanation
    result.push(parsed)
  }

  // Guard against duplicate field names.
  const fields = result.map(q => q.field)
  if (new Set(fields).size !== fields.length) return null

  return result
}

/**
 * Injects any missing system questions (system: true) from `defaults` into `stored`,
 * then sorts the merged list by order ascending.
 * Non-system defaults are never injected — only the instructor's stored copy is used.
 */
export function mergeWithDefaults(
  stored:   PrepTextQuestion[],
  defaults: PrepTextQuestion[],
): PrepTextQuestion[] {
  const result = [...stored]
  for (const def of defaults) {
    if (def.system && !result.some(q => q.field === def.field)) {
      result.push({ ...def })
    }
  }
  return result.sort((a, b) => a.order - b.order)
}

/** Returns an error string on the first violated grading constraint, or null if all pass. */
export function validateQuestionSemantics(questions: PrepTextQuestion[]): string | null {
  for (const q of questions) {
    if (typeof q.role_target !== 'string' || q.role_target.trim() === '') {
      return `Question "${q.field}": role_target must be a non-empty string`
    }
    if (q.explanation !== undefined && typeof q.explanation !== 'string') {
      return `Question "${q.field}": explanation must be a string`
    }
    if (q.category === 'knowledge_check' && q.format !== 'multiple_choice') {
      return `Question "${q.field}": knowledge_check questions must have format 'multiple_choice'`
    }
    if (q.grading === 'static') {
      if (!q.correct_value) {
        return `Question "${q.field}": grading 'static' requires correct_value`
      }
      const optionValues = (q.options ?? []).map(o => o.value)
      if (!optionValues.includes(q.correct_value)) {
        return `Question "${q.field}": correct_value '${q.correct_value}' does not match any option value`
      }
    }
    if (q.grading === 'assigned_role' && q.correct_value !== undefined) {
      return `Question "${q.field}": grading 'assigned_role' must not have correct_value`
    }
  }
  return null
}
