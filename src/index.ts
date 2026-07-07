export type {
  GameDefinition,
  RoleKey,
  MCOption,
  KCQuestion,
  PrepQuestion,
  PrepTextQuestion,
  ConfigFieldDef,
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

export { dispatchResults, reportResult, toGameResult, type GameResult, type PushSummary, type FailedPush } from './classroom/reportResult'

export { makeAssignRole } from './join/makeAssignRole'
export { makeGetInfoUrls } from './join/makeGetInfoUrls'
export { makeCompletePrep } from './join/makeCompletePrep'
export { makeConfirmReady } from './join/makeConfirmReady'
export { makeGenerateAttendanceCode } from './join/makeGenerateAttendanceCode'
export { makeVerifyAttendanceCode } from './join/makeVerifyAttendanceCode'

export { makeGetGameConfig } from './config/makeGetGameConfig'
export { makeUpdateGameConfig } from './config/makeUpdateGameConfig'
export {
  parsePrepTextQuestions,
  mergeWithDefaults,
  validateQuestionSemantics,
  validateKCGate,
} from './config/prepTextQuestions'
export { readConfigField, validateWriteField } from './config/configField'

export { djb2Hash, seededShuffle } from './kc/shuffle'
export { calcKCScore } from './kc/calcKCScore'
export { makeGetStudentPrepQuestions } from './kc/makeGetStudentPrepQuestions'
export { makeSubmitKnowledgeCheck } from './kc/makeSubmitKnowledgeCheck'
export { makeSubmitStaticKnowledgeCheckQuestion } from './kc/makeSubmitStaticKnowledgeCheckQuestion'

export { makeTriggerMatching } from './flow/makeTriggerMatching'
export { makeAdvanceRound } from './flow/makeAdvanceRound'
export { makeStartNegotiation } from './flow/makeStartNegotiation'
export { makeSubmitLeadOutcome } from './flow/makeSubmitLeadOutcome'
export { makeSubmitConfirmation } from './flow/makeSubmitConfirmation'
export { makeSubmitInstructorOutcome } from './flow/makeSubmitInstructorOutcome'
export { makeFinalizeInstance, buildScoringRecord, type CompletedGroup } from './flow/makeFinalizeInstance'
export { makePushResultsToClassroom } from './flow/makePushResultsToClassroom'
export { makeGetDebriefQuestions } from './kc/makeGetDebriefQuestions'
