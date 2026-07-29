import { describe, it, expect } from 'vitest'
import { readConfigField, validateWriteField } from '../../src/config/configField'
import type { ConfigFieldDef } from '../../src/GameDefinition'

// ═══════════════════════════════════════════════════════════════════════════════
// THE 'decimal' CONFIG KIND — probabilities, rates and prices.
//
// ⚠ NOT `OutcomeSchema`'s 'decimal'. That describes a field a STUDENT submits on an
// outcome form. This describes a field an INSTRUCTOR edits in Settings.
//
// ⚠ AND THE SETTINGS PAGE IS NOT THE BOUNDARY. `updateGameConfig` is a public callable;
// anyone holding an instructor session can post to it directly and skip the form
// entirely. Everything the UI checks is checked again here, which is why these tests
// exercise the SERVER validator rather than the input.
// ═══════════════════════════════════════════════════════════════════════════════

const prob = (key: string, def: number): ConfigFieldDef =>
  ({ key, kind: 'decimal', default: def, min: 0, max: 1, step: 0.01 })

describe('validateWriteField — decimal', () => {
  it('accepts a value inside the range', () => {
    expect(validateWriteField(prob('pHigh', 0.5), 0.65)).toBe(0.65)
  })

  it('accepts the inclusive bounds themselves', () => {
    expect(validateWriteField(prob('p', 0.5), 0)).toBe(0)
    expect(validateWriteField(prob('p', 0.5), 1)).toBe(1)
  })

  it('rejects below min, naming the field and the value', () => {
    expect(() => validateWriteField(prob('pHigh', 0.5), -0.01)).toThrow(/pHigh must be at least 0/)
  })

  it('rejects above max', () => {
    expect(() => validateWriteField(prob('pHigh', 0.5), 1.5)).toThrow(/at most 1/)
  })

  it('rejects a non-number, including a numeric STRING', () => {
    // The form posts strings; the page is responsible for parsing. If it ever stops,
    // this must fail loudly rather than store "0.65" and compare it numerically later.
    expect(() => validateWriteField(prob('p', 0.5), '0.65')).toThrow(/must be a number/)
    expect(() => validateWriteField(prob('p', 0.5), null)).toThrow(/must be a number/)
  })

  it('rejects NaN and Infinity', () => {
    expect(() => validateWriteField(prob('p', 0.5), NaN)).toThrow(/must be a number/)
    expect(() => validateWriteField(prob('p', 0.5), Infinity)).toThrow(/must be a number/)
  })

  it('SNAPS to the step instead of rejecting — float dust is not a user error', () => {
    // 0.1 + 0.55 is 0.6500000000000001 in binary floating point. A form round-trip
    // produces values like this routinely; rejecting them would be unusable.
    expect(validateWriteField(prob('p', 0.5), 0.1 + 0.55)).toBe(0.65)
    expect(validateWriteField(prob('p', 0.5), 0.30000000000000004)).toBe(0.3)
  })

  it('snapping happens AFTER the range check, so it cannot smuggle a value into range', () => {
    // 1.004 would snap to 1.00 — but it is out of range when checked, and it is checked
    // first. Snapping must never be a way past a bound.
    expect(() => validateWriteField(prob('p', 0.5), 1.004)).toThrow(/at most 1/)
  })

  it('a field with no step is left exactly as given', () => {
    const f: ConfigFieldDef = { key: 'rate', kind: 'decimal', default: 1 }
    expect(validateWriteField(f, 1.23456789)).toBe(1.23456789)
  })

  it('a field with no bounds accepts negatives', () => {
    const f: ConfigFieldDef = { key: 'adj', kind: 'decimal', default: 0 }
    expect(validateWriteField(f, -7.5)).toBe(-7.5)
  })
})

describe('readConfigField — decimal', () => {
  it('returns a stored finite number', () => {
    expect(readConfigField(prob('p', 0.5), 0.65)).toBe(0.65)
  })

  it('falls back to the default for a non-number', () => {
    expect(readConfigField(prob('p', 0.5), '0.65')).toBe(0.5)
    expect(readConfigField(prob('p', 0.5), undefined)).toBe(0.5)
  })

  it('⚠ does NOT re-check range on read', () => {
    // Deliberate. Anything stored passed validateWriteField. Silently swapping a
    // persisted setting for the default mid-game would change payoffs with nothing on
    // screen to explain it — a wrong number is better diagnosed than hidden.
    expect(readConfigField(prob('p', 0.5), 2)).toBe(2)
  })

  it('0 is returned, not treated as absent', () => {
    // The classic falsy bug: `stored || default` would turn a legitimate 0 into 0.5.
    expect(readConfigField(prob('p', 0.5), 0)).toBe(0)
  })
})

describe('the other kinds are untouched — eight live games depend on it', () => {
  it('positiveInt still rejects a decimal', () => {
    const f: ConfigFieldDef = { key: 'n', kind: 'positiveInt', default: 10 }
    expect(() => validateWriteField(f, 1.5)).toThrow(/positive integer/)
  })
  it('positiveInt still accepts an integer', () => {
    const f: ConfigFieldDef = { key: 'n', kind: 'positiveInt', default: 10 }
    expect(validateWriteField(f, 12)).toBe(12)
  })
  it('string still trims and rejects blank', () => {
    const f: ConfigFieldDef = { key: 's', kind: 'string', default: 'x' }
    expect(validateWriteField(f, '  hi  ')).toBe('hi')
    expect(() => validateWriteField(f, '   ')).toThrow(/non-empty/)
  })
  it('url still accepts a site-relative path and rejects a bare word', () => {
    const f: ConfigFieldDef = { key: 'u', kind: 'url', default: '' }
    expect(validateWriteField(f, '/role-info/x.pdf')).toBe('/role-info/x.pdf')
    expect(() => validateWriteField(f, 'not-a-url')).toThrow()
  })
})
