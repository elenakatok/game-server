import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/auth/verifyFirebaseToken', () => ({
  verifyFirebaseToken: vi.fn(),
}))

vi.mock('../../src/auth/verifyToken', () => ({
  verifyClassroomToken: vi.fn(),
}))

import { extractStudentOnCallIds } from '../../src/auth/studentOnCallAuth'
import { verifyFirebaseToken } from '../../src/auth/verifyFirebaseToken'
import { verifyClassroomToken } from '../../src/auth/verifyToken'

describe('extractStudentOnCallIds — _test bypass', () => {
  it('returns ids from _test in emulator mode', async () => {
    const result = await extractStudentOnCallIds(
      { _test: { participant_id: 'p1', game_instance_id: 'g1' } },
      true,
      undefined,
    )
    expect(result).toEqual({ participantId: 'p1', gameInstanceId: 'g1' })
  })

  it('throws invalid-argument when _test is missing game_instance_id', async () => {
    await expect(
      extractStudentOnCallIds({ _test: { participant_id: 'p1' } }, true, undefined),
    ).rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('throws invalid-argument when _test is missing participant_id', async () => {
    await expect(
      extractStudentOnCallIds({ _test: { game_instance_id: 'g1' } }, true, undefined),
    ).rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('ignores _test when not in emulator mode — falls through to missing-token error', async () => {
    // isEmulator=false → _test bypass skipped → no Bearer → no token → invalid-argument
    await expect(
      extractStudentOnCallIds({ _test: { participant_id: 'p1', game_instance_id: 'g1' } }, false, undefined),
    ).rejects.toMatchObject({ code: 'invalid-argument' })
  })
})

describe('extractStudentOnCallIds — Firebase Bearer path', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns ids from Firebase token for a student', async () => {
    vi.mocked(verifyFirebaseToken).mockResolvedValue({
      uid: 'student-1',
      gameInstanceId: 'game-1',
      role: 'student',
    })
    const result = await extractStudentOnCallIds({}, false, 'Bearer valid-token')
    expect(result).toEqual({ participantId: 'student-1', gameInstanceId: 'game-1' })
  })

  it('throws permission-denied when Firebase token has instructor role', async () => {
    vi.mocked(verifyFirebaseToken).mockResolvedValue({
      uid: 'instr-1',
      gameInstanceId: 'game-1',
      role: 'instructor',
    })
    await expect(
      extractStudentOnCallIds({}, false, 'Bearer instructor-token'),
    ).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('throws unauthenticated when verifyFirebaseToken rejects', async () => {
    vi.mocked(verifyFirebaseToken).mockRejectedValue(new Error('token expired'))
    await expect(
      extractStudentOnCallIds({}, false, 'Bearer bad-token'),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
})

describe('extractStudentOnCallIds — classroom JWT path', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('returns ids from classroom JWT', async () => {
    vi.mocked(verifyClassroomToken).mockReturnValue({
      participant_id: 'p-abc',
      game_instance_id: 'g-abc',
    } as never)
    const result = await extractStudentOnCallIds({ token: 'jwt.token.here' }, false, undefined)
    expect(result).toEqual({ participantId: 'p-abc', gameInstanceId: 'g-abc' })
  })

  it('throws unauthenticated when verifyClassroomToken throws', async () => {
    vi.mocked(verifyClassroomToken).mockImplementation(() => { throw new Error('bad jwt') })
    await expect(
      extractStudentOnCallIds({ token: 'bad.jwt.token' }, false, undefined),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('throws invalid-argument when no token field and no auth header', async () => {
    await expect(
      extractStudentOnCallIds({}, false, undefined),
    ).rejects.toMatchObject({ code: 'invalid-argument' })
  })
})
