import { HttpsError } from 'firebase-functions/v2/https'
import type { ConfigFieldDef } from '../GameDefinition'

export type { ConfigFieldDef }

/**
 * Returns the stored Firestore value if it matches the field's expected type,
 * otherwise returns the declared default. Never throws.
 */
export function readConfigField(field: ConfigFieldDef, stored: unknown): string | number {
  switch (field.kind) {
    case 'string':
      return typeof stored === 'string' ? stored : field.default

    case 'positiveInt':
      return (
        typeof stored === 'number' &&
        Number.isFinite(stored) &&
        stored > 0 &&
        Number.isInteger(stored)
      ) ? stored : field.default

    case 'url':
      // Empty string is treated as "not set" — blank cannot mask a declared default.
      return (typeof stored === 'string' && stored !== '') ? stored : field.default

    case 'decimal':
      // Range is NOT re-checked on read. A stored value got through validateWriteField,
      // and silently swapping a persisted setting for the default at read time would
      // change a running game's payoffs with nothing on screen to explain it. Only a
      // non-finite value — which cannot come from a successful write — falls back.
      return (typeof stored === 'number' && Number.isFinite(stored)) ? stored : field.default
  }
}

/** Snap to the declared quantum, then clear binary-float dust (0.30000000000000004). */
function snap(value: number, step: number | undefined): number {
  if (step === undefined || step <= 0) return value
  const snapped = Math.round(value / step) * step
  const dp = Math.max(0, (String(step).split('.')[1] ?? '').length)
  return Number(snapped.toFixed(dp))
}

/**
 * Validates and normalises a submitted value for a declared config field.
 * Throws HttpsError('invalid-argument') on any validation failure.
 */
export function validateWriteField(field: ConfigFieldDef, value: unknown): string | number {
  switch (field.kind) {
    case 'string': {
      if (typeof value !== 'string' || value.trim() === '')
        throw new HttpsError('invalid-argument', `${field.key} must be a non-empty string`)
      return value.trim()
    }

    case 'positiveInt': {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value <= 0 ||
        !Number.isInteger(value)
      ) throw new HttpsError('invalid-argument', `${field.key} must be a positive integer`)
      return value
    }

    case 'decimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new HttpsError('invalid-argument', `${field.key} must be a number`)
      }
      // ⚠ VALIDATED HERE, SERVER-SIDE, AND NOT ONLY IN THE SETTINGS PAGE. A settings
      // form is a convenience, not a trust boundary: updateGameConfig is a public
      // callable and anyone with an instructor session can post to it directly.
      if (field.min !== undefined && value < field.min) {
        throw new HttpsError('invalid-argument',
          `${field.key} must be at least ${field.min} (got ${value})`)
      }
      if (field.max !== undefined && value > field.max) {
        throw new HttpsError('invalid-argument',
          `${field.key} must be at most ${field.max} (got ${value})`)
      }
      return snap(value, field.step)
    }

    case 'url': {
      if (typeof value !== 'string')
        throw new HttpsError('invalid-argument', `${field.key} must be a string`)
      if (value !== '') {
        // Site-relative path: single leading slash, NOT protocol-relative (//).
        const isSiteRelative = value.startsWith('/') && !value.startsWith('//')
        if (!isSiteRelative) {
          try {
            const parsed = new URL(value)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
          } catch {
            throw new HttpsError(
              'invalid-argument',
              `${field.key}: must be empty, a valid http(s) URL, or a site-relative path starting with /`,
            )
          }
        }
      }
      return value
    }
  }
}
