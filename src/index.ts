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
export {
  ATTENDANCE_BY_ROUND_FIELD,
  presenceAtSlot,
  setRoundPresence,
  getRoundPresence,
} from './join/roundPresence'

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
export {
  selectPlacementGroup,
  type PlacementCandidate,
  type PlacementResult,
} from './flow/placement'
export { placeLatecomer, type PlaceLatecomerResult } from './flow/placeLatecomer'
export { negotiationIsJoinable } from './flow/negotiationJoinable'
export type {
  JoinableContext,
  PlaceContext,
  PlacementParticipant,
} from './flow/placementTypes'
export { makeAdvanceRound } from './flow/makeAdvanceRound'
export {
  ROUND_OUTCOMES_FIELD,
  clampRoundIndex,
  resolveRoundSlot,
  getRoundOutcome,
  setRoundOutcome,
  type RoundSlot,
} from './flow/roundOutcome'
export { reopenGroupPatch } from './flow/reopenGroup'
export { makeStartNegotiation } from './flow/makeStartNegotiation'
export { makeGetGroupMemberEmails } from './flow/makeGetGroupMemberEmails'
export { makeSubmitLeadOutcome } from './flow/makeSubmitLeadOutcome'
export { makeSubmitConfirmation } from './flow/makeSubmitConfirmation'
export { makeSubmitInstructorOutcome } from './flow/makeSubmitInstructorOutcome'
export { makeFinalizeInstance, buildScoringRecord, type CompletedGroup } from './flow/makeFinalizeInstance'
export { makePushResultsToClassroom } from './flow/makePushResultsToClassroom'
export { makeGetDebriefQuestions } from './kc/makeGetDebriefQuestions'

// ── ONLINE / SEAT MANAGEMENT (Slice 2 — ADDITIVE, no existing export changed) ──
// Promoted from Crisis per Extraction Spec §2.1. No game consumes these yet.
export type {
  SeatOccupant, SeatGroup, OnlineDefinition, MakeBotSeatContext,
  MoveResult, FillResult, MoveOutcome, FillOutcome, SeatOpRejection,
} from './online/types'
export {
  leadOf, isFull, freeSeats, canAcceptHuman,
  moveOccupant, ungroupOccupant, fillWithBots, chunkIntoGroups,
  checkSeatingInvariants, populationOf,
  type SeatingPlan, type InvariantViolation,
} from './online/seatOps'
export {
  makeStageGroupAdapter, makeNegotiationGroupAdapter, toSeatGroup,
  type GroupDocAdapter, type GroupDoc, type WriteMembershipInput, type NewGroupInput,
} from './online/groupDocAdapter'
export { groupNumbering, type OnlineContext } from './online/context'
export {
  makeMoveSeat, makeTopUpGroupWithBots, makeGetOnlineGroups, UNGROUP, NEW_GROUP,
} from './online/makeSeatManagement'
export {
  makeGroupParticipantsOnline, makeRecordLogin, makeStartAllGroups,
  type GroupingOptions, type StartAllGroupsOptions,
} from './online/makeOnlineGrouping'
export { makeFlagGroup, type FlagRecord } from './online/makeFlagGroup'
export {
  makeGetOnlineReport,
  type GroupCategory, type GroupProgress, type OnlineReportOptions,
} from './online/makeGetOnlineReport'

export {
  DEFAULT_CALLBACK_SECRET_NAME, callbackSecretName, callbackSecretParam, callbackSecretValue,
} from './callbackSecret'
