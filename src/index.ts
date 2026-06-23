export type {
  GameDefinition,
  RoleKey,
  MCOption,
  KCQuestion,
  PrepQuestion,
} from './GameDefinition'

export { CLASSROOM_PUBLIC_KEY_PEM } from './auth/classroomPublicKey'
export { verifyClassroomToken, type ClassroomTokenPayload } from './auth/verifyToken'
export { verifyFirebaseToken } from './auth/verifyFirebaseToken'
export { extractStudentIds, type MinimalResponse } from './auth/studentAuth'
export { extractInstructorGameId } from './auth/instructorAuth'
export { extractStudentOnCallIds } from './auth/studentOnCallAuth'

export { makeGetInstructorSession } from './session/makeGetInstructorSession'
export { makeGetRoster, mapParticipant, mapGroup, type ParticipantRow, type GroupRow } from './roster/makeGetRoster'
export { makeSyncRoster } from './roster/makeSyncRoster'

export { makeAssignRole } from './join/makeAssignRole'
export { makeCompletePrep } from './join/makeCompletePrep'
export { makeConfirmReady } from './join/makeConfirmReady'
export { makeGenerateAttendanceCode } from './join/makeGenerateAttendanceCode'
export { makeVerifyAttendanceCode } from './join/makeVerifyAttendanceCode'
