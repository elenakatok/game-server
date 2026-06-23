import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyFirebaseToken } from '../../src/auth/verifyFirebaseToken'
import * as admin from 'firebase-admin'

vi.mock('firebase-admin', () => ({
  auth: vi.fn(),
}))

describe('verifyFirebaseToken', () => {
  let verifyIdToken: ReturnType<typeof vi.fn>

  beforeEach(() => {
    verifyIdToken = vi.fn()
    vi.mocked(admin.auth).mockReturnValue({ verifyIdToken } as ReturnType<typeof admin.auth>)
  })

  it('returns decoded uid, gameInstanceId, and role on a valid instructor token', async () => {
    verifyIdToken.mockResolvedValue({
      uid: 'user-001',
      game_instance_id: 'game-abc',
      role: 'instructor',
    })
    const result = await verifyFirebaseToken('Bearer valid-token-123')
    expect(result).toEqual({
      uid: 'user-001',
      gameInstanceId: 'game-abc',
      role: 'instructor',
    })
  })

  it('strips the Bearer prefix before passing to verifyIdToken', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u', game_instance_id: 'g', role: 'student' })
    await verifyFirebaseToken('Bearer raw-id-token')
    expect(verifyIdToken).toHaveBeenCalledWith('raw-id-token')
  })

  it('maps role=student to student', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u2', game_instance_id: 'g2', role: 'student' })
    const result = await verifyFirebaseToken('Bearer tok')
    expect(result.role).toBe('student')
  })

  it('maps any role that is not "instructor" to student', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u3', game_instance_id: 'g3', role: 'unknown' })
    const result = await verifyFirebaseToken('Bearer tok')
    expect(result.role).toBe('student')
  })

  it('rejects when verifyIdToken throws (bad/expired token)', async () => {
    verifyIdToken.mockRejectedValue(new Error('Firebase: Token is invalid or expired'))
    await expect(verifyFirebaseToken('Bearer bad-token')).rejects.toThrow(
      'Firebase: Token is invalid or expired',
    )
  })
})
