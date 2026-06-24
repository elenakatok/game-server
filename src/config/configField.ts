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
  }
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
