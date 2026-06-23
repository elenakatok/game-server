import { describe, it, expect, beforeAll } from 'vitest'
import * as jwt from 'jsonwebtoken'
import * as crypto from 'crypto'
import { verifyClassroomToken } from '../../src/auth/verifyToken'

let testPrivateKey: string
let testPublicKey: string

const BASE_PAYLOAD = {
  participant_id: 'participant-abc',
  name: 'Test Student',
  course_id: 'course-1',
  session_id: 'session-1',
  game_instance_id: 'game-abc',
  game_config_id: 'config-1',
  role: 'student' as const,
  classroom_callback_url: 'https://classroom.example.com/callback',
  callback_secret_id: 'test-secret',
}

function signTestToken(
  payload: Record<string, unknown> = BASE_PAYLOAD,
  privateKey: string = testPrivateKey,
  options: jwt.SignOptions = {},
): string {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: 'classroom-v1',
    issuer: 'classroom.mygames.live',
    subject: payload.participant_id as string ?? 'test-sub',
    expiresIn: '1h',
    ...options,
  })
}

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  testPrivateKey = pair.privateKey
  testPublicKey = pair.publicKey
})

describe('verifyClassroomToken', () => {
  it('accepts a validly signed token and returns the payload', () => {
    const token = signTestToken()
    const result = verifyClassroomToken(token, testPublicKey)
    expect(result.participant_id).toBe('participant-abc')
    expect(result.game_instance_id).toBe('game-abc')
    expect(result.role).toBe('student')
  })

  it('returns all expected payload fields', () => {
    const token = signTestToken()
    const result = verifyClassroomToken(token, testPublicKey)
    expect(result.name).toBe('Test Student')
    expect(result.course_id).toBe('course-1')
    expect(result.session_id).toBe('session-1')
    expect(result.game_config_id).toBe('config-1')
    expect(result.classroom_callback_url).toBe('https://classroom.example.com/callback')
    expect(result.callback_secret_id).toBe('test-secret')
  })

  it('rejects a tampered token (signature verification fails)', () => {
    const token = signTestToken()
    // Flip a byte in the signature (last segment)
    const parts = token.split('.')
    const sig = parts[2]
    parts[2] = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    const tampered = parts.join('.')
    expect(() => verifyClassroomToken(tampered, testPublicKey)).toThrow()
  })

  it('rejects a token signed by a different private key', () => {
    const { privateKey: otherPrivKey, publicKey: otherPubKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    // Sign with other key but verify with testPublicKey
    const token = signTestToken(BASE_PAYLOAD, otherPrivKey)
    expect(() => verifyClassroomToken(token, testPublicKey)).toThrow()
    // Also confirm the other key accepts its own token
    expect(() => verifyClassroomToken(token, otherPubKey)).not.toThrow()
  })

  it('rejects a token with wrong kid', () => {
    const token = signTestToken(BASE_PAYLOAD, testPrivateKey, { keyid: 'wrong-kid' })
    expect(() => verifyClassroomToken(token, testPublicKey)).toThrow('Unexpected key id: wrong-kid')
  })

  it('rejects a token with no kid', () => {
    // jwt.sign with keyid: undefined omits the kid header
    const token = jwt.sign(BASE_PAYLOAD, testPrivateKey, {
      algorithm: 'RS256',
      issuer: 'classroom.mygames.live',
      subject: 'test-sub',
      expiresIn: '1h',
    })
    expect(() => verifyClassroomToken(token, testPublicKey)).toThrow('Unexpected key id: (none)')
  })

  it('rejects a token with wrong issuer', () => {
    const token = signTestToken(BASE_PAYLOAD, testPrivateKey, { issuer: 'evil.example.com' })
    expect(() => verifyClassroomToken(token, testPublicKey)).toThrow()
  })

  it('rejects an expired token', () => {
    const token = signTestToken(BASE_PAYLOAD, testPrivateKey, { expiresIn: -1 })
    expect(() => verifyClassroomToken(token, testPublicKey)).toThrow()
  })
})
