import type {
  ConversationContext,
  FollowupQuestion,
  PersonConnection,
  PreparedQuestion,
  TranscriptItem,
} from '../types'
import {
  DEFAULT_PREPARED_QUESTION_SLOT_COUNT,
  PREPARED_QUESTION_SLOT_COUNT,
  resolvePreparedSlotCount,
} from './preparedQuestions'

export const WORKSPACE_STORAGE_KEY = 'aiyk.workspace.v2'
export const MAX_PREPARED_QUESTIONS = PREPARED_QUESTION_SLOT_COUNT
export const MAX_LINKED_PEOPLE = 50
export const MAX_WORKSPACE_BYTES = 4_500_000
export const PERSON_LIMITS = { name: 100, details: 2_000, email: 254, notes: 2_000 } as const

export type WorkspaceState = {
  schemaVersion: 2
  activeContextId: string
  contexts: ConversationContext[]
}

export type InterpreterSnapshot = Pick<
  ConversationContext,
  'segments' | 'questions' | 'lastQuestionGeneratedAt'
>

function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `${prefix}-${random}`
}

export function formatDefaultContextTitle(createdAt = Date.now()): string {
  const created = new Date(createdAt)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `New context · ${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}`
}

export function createConversationContext(_index = 1): ConversationContext {
  const now = Date.now()
  return {
    id: makeId('context'),
    title: formatDefaultContextTitle(now),
    createdAt: now,
    updatedAt: now,
    segments: [],
    questions: [],
    preparedQuestions: [],
    preparedSlotCount: DEFAULT_PREPARED_QUESTION_SLOT_COUNT,
    people: [],
  }
}

export function formatRelativeUpdatedAt(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt)) return '수정 시간 없음'
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < 60_000) return '방금 전 수정'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전 수정`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전 수정`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}일 전 수정`
  return `${new Date(updatedAt).toLocaleDateString('ko-KR')} 수정`
}

export function sortContextsByRecent(contexts: ConversationContext[]): ConversationContext[] {
  return [...contexts].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
  )
}

export function createWorkspace(): WorkspaceState {
  const context = createConversationContext(1)
  return { schemaVersion: 2, activeContextId: context.id, contexts: [context] }
}

/**
 * Reconciles the durable SQLite snapshot with a browser snapshot without ever
 * dropping a context that exists in only one source. SQLite wins ties because
 * it is the cross-tab durable store; a newer browser version of the same
 * context is retained so pagehide changes made just before reload are not lost.
 */
export function mergeWorkspaceSources(
  databaseWorkspace: WorkspaceState,
  browserWorkspace: WorkspaceState,
): WorkspaceState {
  const browserById = new Map(browserWorkspace.contexts.map((context) => [context.id, context]))
  const contexts = databaseWorkspace.contexts.map((databaseContext) => {
    const browserContext = browserById.get(databaseContext.id)
    browserById.delete(databaseContext.id)
    if (!browserContext) return databaseContext
    if (browserContext.updatedAt > databaseContext.updatedAt) return browserContext
    if (browserContext.updatedAt < databaseContext.updatedAt) return databaseContext
    const databaseWeight = databaseContext.segments.length + databaseContext.preparedQuestions.length
    const browserWeight = browserContext.segments.length + browserContext.preparedQuestions.length
    return browserWeight > databaseWeight ? browserContext : databaseContext
  })
  contexts.push(...browserById.values())
  const activeContextId = contexts.some(
    (context) => context.id === databaseWorkspace.activeContextId,
  )
    ? databaseWorkspace.activeContextId
    : contexts[0].id
  return { schemaVersion: 2, activeContextId, contexts }
}

function isPristineContext(context: ConversationContext): boolean {
  return (
    context.segments.length === 0
    && context.questions.length === 0
    && context.preparedQuestions.length === 0
    && context.people.length === 0
    && context.recordingStartedAt === undefined
  )
}

/**
 * Gives a newly opened browser tab an isolated empty context. A completely new
 * workspace already has one, so the first visit does not create a duplicate.
 */
export function openFreshTabContext(workspace: WorkspaceState): WorkspaceState {
  if (workspace.contexts.length === 1 && isPristineContext(workspace.contexts[0])) {
    return workspace
  }
  const context = createConversationContext(workspace.contexts.length + 1)
  return {
    ...workspace,
    activeContextId: context.id,
    contexts: [context, ...workspace.contexts],
  }
}

function isTranscriptItem(value: unknown): value is TranscriptItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TranscriptItem>
  return (
    typeof item.id === 'string'
    && typeof item.english === 'string'
    && typeof item.korean === 'string'
    && typeof item.createdAt === 'number'
    && (item.kind === 'transcript' || item.kind === 'question')
    && (item.speaker === undefined || typeof item.speaker === 'string')
    && (item.refinedAt === undefined || (
      typeof item.refinedAt === 'number' && Number.isFinite(item.refinedAt)
    ))
    && (item.sourceIds === undefined || (
      Array.isArray(item.sourceIds) && item.sourceIds.every((id) => typeof id === 'string')
    ))
    && (item.rawEnglish === undefined || typeof item.rawEnglish === 'string')
    && (item.rawKorean === undefined || typeof item.rawKorean === 'string')
    && ['pending', 'ready', 'waiting', 'error'].includes(String(item.translationState))
  )
}

function isFollowupQuestion(value: unknown): value is FollowupQuestion {
  if (!value || typeof value !== 'object') return false
  const question = value as Partial<FollowupQuestion>
  return (
    typeof question.id === 'string'
    && typeof question.ko === 'string'
    && typeof question.en === 'string'
    && (question.stance === 'support' || question.stance === 'critique' || question.stance === 'rebuttal')
  )
}

function isPreparedQuestion(value: unknown): value is PreparedQuestion {
  if (!value || typeof value !== 'object') return false
  const question = value as Partial<PreparedQuestion>
  return (
    typeof question.id === 'string'
    && typeof question.ko === 'string'
    && typeof question.en === 'string'
    && (question.pronunciation === undefined || typeof question.pronunciation === 'string')
    && (question.pronunciationEnglish === undefined || typeof question.pronunciationEnglish === 'string')
    && typeof question.createdAt === 'number'
  )
}

function normalizePersonConnection(value: unknown): PersonConnection | null {
  if (!value || typeof value !== 'object') return null
  const person = value as Partial<PersonConnection>
  if (
    typeof person.id !== 'string'
    || typeof person.name !== 'string'
    || !person.name.trim()
    || typeof person.createdAt !== 'number'
    || !Number.isFinite(person.createdAt)
  ) return null
  return {
    id: person.id,
    name: person.name.trim().slice(0, PERSON_LIMITS.name),
    details: typeof person.details === 'string'
      ? person.details.trim().slice(0, PERSON_LIMITS.details)
      : '',
    email: typeof person.email === 'string'
      ? person.email.trim().slice(0, PERSON_LIMITS.email)
      : '',
    notes: typeof person.notes === 'string'
      ? person.notes.trim().slice(0, PERSON_LIMITS.notes)
      : '',
    createdAt: person.createdAt,
  }
}

export function parseWorkspace(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<WorkspaceState>
  if (candidate.schemaVersion !== 2 || !Array.isArray(candidate.contexts)) return null

  const contexts = candidate.contexts.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const context = value as Partial<ConversationContext>
    if (
      typeof context.id !== 'string'
      || typeof context.title !== 'string'
      || typeof context.createdAt !== 'number'
      || !Number.isFinite(context.createdAt)
      || !Array.isArray(context.segments)
      || !Array.isArray(context.questions)
      || !Array.isArray(context.preparedQuestions)
      || (context.recordingStartedAt !== undefined && (
        typeof context.recordingStartedAt !== 'number'
        || !Number.isFinite(context.recordingStartedAt)
      ))
    ) {
      return []
    }
    const normalizedTitle = context.title.trim() || 'Untitled context'
    const preparedQuestions = context.preparedQuestions
      .filter(isPreparedQuestion)
      .slice(0, MAX_PREPARED_QUESTIONS)
    return [{
      ...context,
      title: normalizedTitle.replace(/^새 컨텍스트\s+(\d+)$/, 'New context $1'),
      updatedAt: typeof context.updatedAt === 'number' && Number.isFinite(context.updatedAt)
        ? context.updatedAt
        : context.createdAt,
      segments: context.segments.filter(isTranscriptItem),
      questions: context.questions.filter(isFollowupQuestion),
      preparedQuestions,
      preparedSlotCount: resolvePreparedSlotCount(
        preparedQuestions,
        context.preparedSlotCount,
      ),
      people: Array.isArray(context.people)
        ? context.people
            .map(normalizePersonConnection)
            .filter((person): person is PersonConnection => Boolean(person))
            .slice(0, MAX_LINKED_PEOPLE)
        : [],
    } as ConversationContext]
  })

  if (!contexts.length) return null
  const activeContextId = contexts.some((context) => context.id === candidate.activeContextId)
    ? String(candidate.activeContextId)
    : contexts[0].id
  return { schemaVersion: 2, activeContextId, contexts }
}

export function loadWorkspace(): WorkspaceState {
  if (typeof window === 'undefined') return createWorkspace()
  const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
  if (!raw) return createWorkspace()
  try {
    const parsed = parseWorkspace(JSON.parse(raw) as unknown)
    if (parsed) {
      if (JSON.stringify(parsed) !== raw) {
        try {
          window.localStorage.setItem(`aiyk.workspace.migration.${Date.now()}`, raw)
        } catch {
          // The normalized workspace remains usable when a backup cannot be written.
        }
      }
      return parsed
    }
    window.localStorage.setItem(`aiyk.workspace.corrupt.${Date.now()}`, raw)
  } catch {
    try {
      window.localStorage.setItem(`aiyk.workspace.corrupt.${Date.now()}`, raw)
    } catch {
      // A corrupt payload should never prevent the app from opening.
    }
  }
  return createWorkspace()
}

export function hasStoredWorkspace(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage.getItem(WORKSPACE_STORAGE_KEY))
}

export function saveWorkspace(workspace: WorkspaceState): string | null {
  if (typeof window === 'undefined') return null
  try {
    const serialized = JSON.stringify(workspace)
    if (new Blob([serialized]).size > MAX_WORKSPACE_BYTES) {
      return '저장 용량이 4.5MB를 넘었습니다. Text 파일로 내보낸 뒤 오래된 컨텍스트를 정리해 주세요.'
    }
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, serialized)
    return null
  } catch {
    return '브라우저 저장 공간이 부족해 컨텍스트를 저장하지 못했습니다.'
  }
}

export function mergeInterpreterSnapshot(
  workspace: WorkspaceState,
  contextId: string,
  snapshot: InterpreterSnapshot,
  updatedAt: number,
): WorkspaceState {
  let changed = false
  const contexts = workspace.contexts.map((context) => {
    if (context.id !== contextId) return context
    if (
      context.segments === snapshot.segments
      && context.questions === snapshot.questions
      && context.lastQuestionGeneratedAt === snapshot.lastQuestionGeneratedAt
    ) {
      return context
    }
    changed = true
    return {
      ...context,
      segments: snapshot.segments,
      questions: snapshot.questions,
      lastQuestionGeneratedAt: snapshot.lastQuestionGeneratedAt,
      updatedAt,
    }
  })
  return changed ? { ...workspace, contexts } : workspace
}

export function removeConversationContext(
  workspace: WorkspaceState,
  contextId: string,
): WorkspaceState | null {
  if (workspace.contexts.length <= 1) return null
  const contexts = workspace.contexts.filter((context) => context.id !== contextId)
  if (!contexts.length || contexts.length === workspace.contexts.length) return null
  return {
    ...workspace,
    activeContextId: workspace.activeContextId === contextId
      ? contexts[0].id
      : workspace.activeContextId,
    contexts,
  }
}

export function textFilename(context: ConversationContext): string {
  const recorded = new Date(context.recordingStartedAt || context.createdAt)
  const year = recorded.getFullYear()
  const month = String(recorded.getMonth() + 1).padStart(2, '0')
  const day = String(recorded.getDate()).padStart(2, '0')
  const date = `${year}-${month}-${day}`
  const safeTitle = context.title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'AIYK-context'
  return `${date}-${safeTitle}.txt`
}

export function splitEnglishForPresentation(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  let sentences: string[] = []
  try {
    const Segmenter = Intl.Segmenter
    sentences = [...new Segmenter('en', { granularity: 'sentence' }).segment(clean)]
      .map((part) => part.segment.trim())
      .filter(Boolean)
  } catch {
    sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean)
  }

  return sentences.flatMap((sentence) => {
    if (sentence.length <= 78) return [sentence]
    const clauses = sentence.split(/(?<=[,;:—])\s+|\s+(?=(?:and|but|because|while|which|that)\b)/i)
    return clauses.filter(Boolean)
  })
}
