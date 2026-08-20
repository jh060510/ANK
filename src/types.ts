export type ConnectionState =
  | 'idle'
  | 'requesting-permission'
  | 'connecting'
  | 'listening'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'error'

export type TranslationState = 'pending' | 'ready' | 'waiting' | 'error'

export type TranscriptItem = {
  id: string
  english: string
  korean: string
  translationState: TranslationState
  createdAt: number
  kind: 'transcript' | 'question'
  speaker?: string
  refinedAt?: number
  sourceIds?: string[]
  rawEnglish?: string
  rawKorean?: string
}

export type LiveTranscript = {
  activityLength: number
}

export type FollowupQuestion = {
  id: string
  stance: 'support' | 'critique' | 'rebuttal'
  ko: string
  en: string
}

export type AppConfig = {
  deepgramConfigured: boolean
  translationConfigured: boolean
}

export type DeepgramResult = {
  type: 'Results'
  is_final: boolean
  speech_final: boolean
  from_finalize?: boolean
  start?: number
  duration?: number
  channel?: {
    alternatives?: Array<{
      transcript?: string
      words?: Array<{
        word?: string
        punctuated_word?: string
        speaker?: number
      }>
    }>
  }
}

export type PreparedQuestion = {
  id: string
  ko: string
  en: string
  pronunciation?: string
  /** Exact English sentence used to generate pronunciation. Missing on legacy data. */
  pronunciationEnglish?: string
  createdAt: number
  slot?: number
}

export type PersonConnection = {
  id: string
  name: string
  details: string
  email: string
  notes: string
  createdAt: number
}

export type ConversationContext = {
  id: string
  title: string
  createdAt: number
  recordingStartedAt?: number
  updatedAt: number
  segments: TranscriptItem[]
  questions: FollowupQuestion[]
  lastQuestionGeneratedAt?: number
  preparedQuestions: PreparedQuestion[]
  preparedSlotCount?: number
  people: PersonConnection[]
}
