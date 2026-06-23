import * as admin from 'firebase-admin'

export async function verifyFirebaseToken(authHeader: string): Promise<{
  uid: string
  gameInstanceId: string
  role: 'instructor' | 'student'
}> {
  const idToken = authHeader.replace(/^Bearer /, '')
  const decoded = await admin.auth().verifyIdToken(idToken)
  return {
    uid: decoded.uid,
    gameInstanceId: decoded.game_instance_id as string,
    role: decoded.role === 'instructor' ? 'instructor' : 'student',
  }
}
