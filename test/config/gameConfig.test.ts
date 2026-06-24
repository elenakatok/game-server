import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HttpsError } from 'firebase-functions/v2/https'
import { parsePrepTextQuestions, mergeWithDefaults, validateQuestionSemantics } from '../../src/config/prepTextQuestions'
import { readConfigField, validateWriteField } from '../../src/config/configField'
import { extractInstructorGameId } from '../../src/auth/instructorAuth'
import type { PrepTextQuestion, ConfigFieldDef } from '../../src/GameDefinition'
import * as admin from 'firebase-admin'

vi.mock('firebase-admin', () => ({ auth: vi.fn() }))

// ── readConfigField ───────────────────────────────────────────────────────────

describe('readConfigField — string', () => {
  const field: ConfigFieldDef = { key: 'seller_name', kind: 'string', default: 'Chris' }

  it('returns stored string value', () => {
    expect(readConfigField(field, 'Bob')).toBe('Bob')
  })
  it('returns default for undefined', () => {
    expect(readConfigField(field, undefined)).toBe('Chris')
  })
  it('returns default for wrong-type value', () => {
    expect(readConfigField(field, 42)).toBe('Chris')
  })
  it('returns stored empty string (empty is a valid string)', () => {
    expect(readConfigField(field, '')).toBe('')
  })
})

describe('readConfigField — positiveInt', () => {
  const field: ConfigFieldDef = { key: 'reservation_price', kind: 'positiveInt', default: 25000 }

  it('returns stored positive integer', () => {
    expect(readConfigField(field, 30000)).toBe(30000)
  })
  it('returns default for zero', () => {
    expect(readConfigField(field, 0)).toBe(25000)
  })
  it('returns default for negative', () => {
    expect(readConfigField(field, -1)).toBe(25000)
  })
  it('returns default for non-integer float', () => {
    expect(readConfigField(field, 1.5)).toBe(25000)
  })
  it('returns default for a numeric string', () => {
    expect(readConfigField(field, '30000')).toBe(25000)
  })
  it('returns default for undefined', () => {
    expect(readConfigField(field, undefined)).toBe(25000)
  })
})

describe('readConfigField — url', () => {
  const field: ConfigFieldDef = { key: 'public_info_url', kind: 'url', default: '/role-info/public.pdf' }

  it('returns stored non-empty URL path', () => {
    expect(readConfigField(field, '/my-path/file.pdf')).toBe('/my-path/file.pdf')
  })
  it('returns stored non-empty https URL', () => {
    expect(readConfigField(field, 'https://dropbox.com/file.pdf')).toBe('https://dropbox.com/file.pdf')
  })
  it('returns default for undefined (never stored)', () => {
    expect(readConfigField(field, undefined)).toBe('/role-info/public.pdf')
  })
  it('returns default for non-string', () => {
    expect(readConfigField(field, 42)).toBe('/role-info/public.pdf')
  })
  // Blank-masking fix: empty string is "not set", not an intentional override.
  // A blank save (e.g. race condition before defaults load) cannot permanently mask the default.
  it('treats stored "" as not-set — returns default, not blank', () => {
    expect(readConfigField(field, '')).toBe('/role-info/public.pdf')
  })
  it('field with default "" and stored "" still returns "" (blank default, blank stored — consistent)', () => {
    const emptyDefault: ConfigFieldDef = { key: 'optional_url', kind: 'url', default: '' }
    expect(readConfigField(emptyDefault, '')).toBe('')
  })
})

// Blank-masking proof: simulates the blank-save race condition scenario.
// A save fired before getGameConfig returns writes "" for defaulted url fields.
// After the fix, readConfigField returns the declared default — the blank cannot mask it.
describe('readConfigField — url blank-masking proof', () => {
  const linkField: ConfigFieldDef = { key: 'winemaster_sheet_url', kind: 'url', default: '/role-info/winemaster.pdf' }

  it('fresh instance (undefined) → returns declared default path', () => {
    expect(readConfigField(linkField, undefined)).toBe('/role-info/winemaster.pdf')
  })
  it('blank-saved ("") → returns declared default path, not blank', () => {
    expect(readConfigField(linkField, '')).toBe('/role-info/winemaster.pdf')
  })
  it('instructor override → stored non-empty path returned as-is', () => {
    expect(readConfigField(linkField, 'https://dropbox.com/wm-role.pdf')).toBe('https://dropbox.com/wm-role.pdf')
  })
  it('site-relative override → stored as-is', () => {
    expect(readConfigField(linkField, '/custom/winemaster.pdf')).toBe('/custom/winemaster.pdf')
  })
})

// ── validateWriteField ────────────────────────────────────────────────────────

describe('validateWriteField — string', () => {
  const field: ConfigFieldDef = { key: 'seller_name', kind: 'string', default: 'Chris' }

  it('accepts non-empty string', () => {
    expect(validateWriteField(field, 'Alice')).toBe('Alice')
  })
  it('trims surrounding whitespace', () => {
    expect(validateWriteField(field, '  Alice  ')).toBe('Alice')
  })
  it('rejects empty string', () => {
    expect(() => validateWriteField(field, '')).toThrow(HttpsError)
  })
  it('rejects whitespace-only string', () => {
    expect(() => validateWriteField(field, '   ')).toThrow(HttpsError)
  })
  it('rejects non-string', () => {
    expect(() => validateWriteField(field, 42)).toThrow(HttpsError)
  })
})

describe('validateWriteField — positiveInt', () => {
  const field: ConfigFieldDef = { key: 'reservation_price', kind: 'positiveInt', default: 25000 }

  it('accepts a positive integer', () => {
    expect(validateWriteField(field, 50000)).toBe(50000)
  })
  it('rejects zero', () => {
    expect(() => validateWriteField(field, 0)).toThrow(HttpsError)
  })
  it('rejects negative', () => {
    expect(() => validateWriteField(field, -100)).toThrow(HttpsError)
  })
  it('rejects a non-integer float', () => {
    expect(() => validateWriteField(field, 1.5)).toThrow(HttpsError)
  })
  it('rejects a numeric string', () => {
    expect(() => validateWriteField(field, '100')).toThrow(HttpsError)
  })
})

describe('validateWriteField — url', () => {
  const field: ConfigFieldDef = { key: 'info_url', kind: 'url', default: '' }

  it('accepts empty string (intentionally unset)', () => {
    expect(validateWriteField(field, '')).toBe('')
  })
  it('accepts site-relative path', () => {
    expect(validateWriteField(field, '/role-info/seller.pdf')).toBe('/role-info/seller.pdf')
  })
  it('accepts https URL', () => {
    expect(validateWriteField(field, 'https://example.com/file.pdf')).toBe('https://example.com/file.pdf')
  })
  it('accepts http URL', () => {
    expect(validateWriteField(field, 'http://example.com/file.pdf')).toBe('http://example.com/file.pdf')
  })
  it('rejects protocol-relative URL', () => {
    expect(() => validateWriteField(field, '//evil.com/path')).toThrow(HttpsError)
  })
  it('rejects bare string without slash', () => {
    expect(() => validateWriteField(field, 'not a url')).toThrow(HttpsError)
  })
  it('rejects javascript: scheme', () => {
    expect(() => validateWriteField(field, 'javascript:alert(1)')).toThrow(HttpsError)
  })
  it('rejects non-string value', () => {
    expect(() => validateWriteField(field, 42)).toThrow(HttpsError)
  })
})

// ── parsePrepTextQuestions ────────────────────────────────────────────────────

const BASE_Q: PrepTextQuestion = {
  field: 'prep_first_topic', type: 'text', system: false, category: 'preparation',
  format: 'text', role_target: 'all', prompt: 'What topic?', placeholder: '',
  order: 0, hidden: false, deletable: true,
}

describe('parsePrepTextQuestions', () => {
  it('returns null for non-array input', () => {
    expect(parsePrepTextQuestions(null)).toBeNull()
    expect(parsePrepTextQuestions('text')).toBeNull()
    expect(parsePrepTextQuestions(42)).toBeNull()
  })
  it('parses an empty array', () => {
    expect(parsePrepTextQuestions([])).toEqual([])
  })
  it('parses a single valid question', () => {
    const result = parsePrepTextQuestions([BASE_Q])
    expect(result).toHaveLength(1)
    expect(result![0].field).toBe('prep_first_topic')
  })
  it('returns null when field name has no recognised prefix', () => {
    expect(parsePrepTextQuestions([{ ...BASE_Q, field: 'custom_field' }])).toBeNull()
  })
  it('accepts "knowledge_check" as a field name', () => {
    const kcQ = {
      ...BASE_Q, field: 'knowledge_check', type: 'mc' as const,
      format: 'multiple_choice' as const, category: 'knowledge_check' as const,
      options: [{ value: 'a', label: 'A' }],
    }
    expect(parsePrepTextQuestions([kcQ])).not.toBeNull()
  })
  it('returns null on duplicate field names', () => {
    expect(parsePrepTextQuestions([BASE_Q, { ...BASE_Q }])).toBeNull()
  })
  it('returns null when list exceeds 50 items', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...BASE_Q, field: `prep_q${i}` }))
    expect(parsePrepTextQuestions(many)).toBeNull()
  })
  it('normalises legacy role_target "both" to "all"', () => {
    const result = parsePrepTextQuestions([{ ...BASE_Q, role_target: 'both' }])
    expect(result![0].role_target).toBe('all')
  })
  it('preserves a specific role key as role_target', () => {
    const result = parsePrepTextQuestions([{ ...BASE_Q, role_target: 'winemaster' }])
    expect(result![0].role_target).toBe('winemaster')
  })
  it('returns null when mc question is missing options', () => {
    expect(parsePrepTextQuestions([{ ...BASE_Q, type: 'mc' }])).toBeNull()
  })
  it('returns null when an mc option is missing a label', () => {
    const q = { ...BASE_Q, type: 'mc' as const, options: [{ value: 'a' }] }
    expect(parsePrepTextQuestions([q])).toBeNull()
  })
})

// ── mergeWithDefaults — merge-write preserves unlisted fields ─────────────────

const SYSTEM_Q: PrepTextQuestion = {
  field: 'prep_estimated_other_price', type: 'number', system: true,
  category: 'preparation', format: 'number', role_target: 'all',
  prompt: 'Best guess of the other side\'s reservation price?',
  placeholder: 'e.g. 250000', order: 1, hidden: false, deletable: false,
}
const NON_SYSTEM_Q: PrepTextQuestion = {
  field: 'prep_planned_offer', type: 'text', system: false,
  category: 'preparation', format: 'text', role_target: 'all',
  prompt: 'Your plan?', placeholder: '', order: 3, hidden: false, deletable: true,
}

describe('mergeWithDefaults', () => {
  it('injects a missing system question from defaults', () => {
    const result = mergeWithDefaults([], [SYSTEM_Q])
    expect(result).toHaveLength(1)
    expect(result[0].field).toBe(SYSTEM_Q.field)
  })
  it('does NOT inject non-system defaults when absent from stored list', () => {
    const result = mergeWithDefaults([], [NON_SYSTEM_Q])
    expect(result).toHaveLength(0)
  })
  it('does not duplicate a system question already in stored', () => {
    const result = mergeWithDefaults([SYSTEM_Q], [SYSTEM_Q])
    expect(result).toHaveLength(1)
  })
  it('preserves stored questions that are not in the defaults list', () => {
    const extra: PrepTextQuestion = { ...BASE_Q, field: 'prep_extra', order: 10 }
    const result = mergeWithDefaults([extra], [SYSTEM_Q])
    expect(result).toHaveLength(2)
    expect(result.some(q => q.field === 'prep_extra')).toBe(true)
  })
  it('sorts the merged result by order ascending', () => {
    const late: PrepTextQuestion = { ...BASE_Q, field: 'prep_last', order: 5 }
    const result = mergeWithDefaults([late], [SYSTEM_Q])
    expect(result[0].order).toBe(1)
    expect(result[1].order).toBe(5)
  })
  it('returns an empty array when stored is empty and defaults have no system questions', () => {
    expect(mergeWithDefaults([], [NON_SYSTEM_Q])).toEqual([])
  })
})

// ── validateQuestionSemantics ─────────────────────────────────────────────────

describe('validateQuestionSemantics', () => {
  it('returns null for a valid list', () => {
    expect(validateQuestionSemantics([BASE_Q])).toBeNull()
  })
  it('returns null for an empty list', () => {
    expect(validateQuestionSemantics([])).toBeNull()
  })
  it('rejects knowledge_check question with non-mc format', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'knowledge_check', category: 'knowledge_check', format: 'text',
    }
    expect(validateQuestionSemantics([q])).not.toBeNull()
  })
  it('rejects grading:static without correct_value', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'kc_test', type: 'mc', format: 'multiple_choice',
      category: 'knowledge_check', grading: 'static',
      options: [{ value: 'a', label: 'A' }],
    }
    expect(validateQuestionSemantics([q])).not.toBeNull()
  })
  it('rejects grading:static when correct_value is not in options', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'kc_test', type: 'mc', format: 'multiple_choice',
      category: 'knowledge_check', grading: 'static', correct_value: 'z',
      options: [{ value: 'a', label: 'A' }],
    }
    expect(validateQuestionSemantics([q])).not.toBeNull()
  })
  it('accepts grading:static with correct_value matching an option', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'kc_test', type: 'mc', format: 'multiple_choice',
      category: 'knowledge_check', grading: 'static', correct_value: 'a',
      options: [{ value: 'a', label: 'A' }],
    }
    expect(validateQuestionSemantics([q])).toBeNull()
  })
  it('rejects grading:assigned_role with correct_value present', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'kc_test', type: 'mc', format: 'multiple_choice',
      category: 'knowledge_check', grading: 'assigned_role', correct_value: 'a',
      options: [{ value: 'a', label: 'A' }],
    }
    expect(validateQuestionSemantics([q])).not.toBeNull()
  })
  it('accepts grading:assigned_role without correct_value', () => {
    const q: PrepTextQuestion = {
      ...BASE_Q, field: 'kc_test', type: 'mc', format: 'multiple_choice',
      category: 'knowledge_check', grading: 'assigned_role',
      options: [{ value: 'a', label: 'A' }],
    }
    expect(validateQuestionSemantics([q])).toBeNull()
  })
})

// ── auth rejection ────────────────────────────────────────────────────────────

describe('extractInstructorGameId — auth rejection', () => {
  let verifyIdToken: ReturnType<typeof vi.fn>

  beforeEach(() => {
    verifyIdToken = vi.fn()
    vi.mocked(admin.auth).mockReturnValue({ verifyIdToken } as ReturnType<typeof admin.auth>)
  })

  it('throws invalid-argument when there is no token and no Bearer header', async () => {
    await expect(extractInstructorGameId({}, false, undefined)).rejects.toMatchObject({
      code: 'invalid-argument',
    })
  })

  it('throws unauthenticated when the Firebase token is rejected', async () => {
    verifyIdToken.mockRejectedValue(new Error('Token expired'))
    await expect(
      extractInstructorGameId({}, false, 'Bearer bad-token'),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('throws permission-denied when a valid student token tries instructor path', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1', game_instance_id: 'g1', role: 'student' })
    await expect(
      extractInstructorGameId({}, false, 'Bearer student-token'),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })
})
