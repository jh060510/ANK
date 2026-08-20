import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import { useLiveInterpreter } from './hooks/useLiveInterpreter'
import {
  createConversationContext,
  formatRelativeUpdatedAt,
  hasStoredWorkspace,
  loadWorkspace,
  mergeInterpreterSnapshot,
  mergeWorkspaceSources,
  openFreshTabContext,
  removeConversationContext,
  parseWorkspace,
  textFilename,
  saveWorkspace,
  sortContextsByRecent,
  splitEnglishForPresentation,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceState,
} from './lib/contexts'
import {
  arrangePreparedQuestionSlots,
  clearPreparedQuestionSlot,
  summarizePreparedQuestion,
  upsertPreparedQuestionSlot,
} from './lib/preparedQuestions'
import {
  exportChatText,
  generateEnglishPronunciation,
  loadWorkspaceFromDatabase,
  polishQuestionDetailed,
  saveWorkspaceToDatabase,
} from './lib/api'
import { combineBilingualExportParts, exportBatches, rawChatText } from './lib/chatTextExport'
import type {
  ConnectionState,
  ConversationContext,
  FollowupQuestion,
  PreparedQuestion,
  TranscriptItem,
  TranslationState,
} from './types'

const statusCopy: Record<ConnectionState, { label: string; detail: string }> = {
  idle: { label: '준비됨', detail: '마이크를 눌러 시작하세요' },
  'requesting-permission': { label: '권한 확인', detail: '마이크 권한을 확인하고 있어요' },
  connecting: { label: '연결 중', detail: '실시간 채널을 열고 있어요' },
  listening: { label: '듣는 중', detail: '확정되는 말부터 빠르게 번역해요' },
  reconnecting: { label: '재연결 중', detail: '대화를 유지하며 연결을 복구해요' },
  stopping: { label: '마무리 중', detail: '마지막 단어만 안전하게 정리해요' },
  stopped: { label: '일시 정지', detail: '번역 중 표시는 모두 정리됐어요' },
  error: { label: '확인 필요', detail: '아래 안내를 확인해 주세요' },
}

type PresentationPayload = {
  label: string
  ko: string
  en: string
  pronunciation?: string
  pronunciationLoading?: boolean
  sourceKey?: string
}

type ComposerMode = 'direct' | 'prepared'
type ComposerStage = 'idle' | 'loading' | 'final' | 'error'

function questionPronunciation(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  for (const key of ['pronunciation', 'pronunciationGuide', 'koreanPronunciation']) {
    if (typeof record[key] === 'string') return record[key].trim()
  }
  return ''
}

function normalizePolishedQuestion(value: unknown): { english: string; pronunciation: string } {
  if (typeof value === 'string') return { english: value.trim(), pronunciation: '' }
  if (!value || typeof value !== 'object') return { english: '', pronunciation: '' }
  const record = value as Record<string, unknown>
  return {
    english: typeof record.english === 'string' ? record.english.trim() : '',
    pronunciation: questionPronunciation(record),
  }
}

const CONTEXT_REFINEMENT_INTERVAL_MS = 10 * 60_000

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function BrandLogo() {
  return (
    <span className="brand-image" role="img" aria-label="AIYK">
      <img src="/aiyk-logo-original.png" alt="" draggable="false" />
    </span>
  )
}

type ToolIconName = 'prepared' | 'export' | 'menu' | 'close' | 'edit'

function ToolIcon({ name }: { name: ToolIconName }) {
  if (name === 'prepared') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
  if (name === 'export') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 20h14" /></svg>
  if (name === 'menu') return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M9 4v16M6 8h.01M6 12h.01" /></svg>
  if (name === 'close') return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20ZM13.8 7.7l3 3" /></svg>
}

function MicIcon({ active }: { active: boolean }) {
  return active ? (
    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M9 3h6l1 4H8l1-4Zm-2 4 1 14h8l1-14M10 11v6M14 11v6" />
    </svg>
  )
}

function StatusPill({ status }: { status: ConnectionState }) {
  return (
    <div className={`status-pill status-${status}`} role="status" aria-live="polite">
      <span className="status-dot" />
      <span>{statusCopy[status].label}</span>
    </div>
  )
}

function TranslationCopy({ state, status }: { state: TranslationState; status: ConnectionState }) {
  if (state === 'pending') {
    return status === 'listening'
      ? <span className="translation-wait">한국어로 옮기는 중…</span>
      : <span className="translation-wait">일시 정지됨 · 준비된 결과만 표시됩니다.</span>
  }
  if (state === 'waiting') return <span className="translation-wait">번역 연결을 기다리고 있어요.</span>
  if (state === 'error') return <span className="translation-error">번역을 가져오지 못했거나 일시 정지됐어요.</span>
  return null
}

function TranscriptCard({
  item,
  status,
  speakerLabel,
  onDelete,
  onPresent,
  onRetry,
}: {
  item: TranscriptItem
  status: ConnectionState
  speakerLabel: string
  onDelete: () => void
  onPresent: () => void
  onRetry?: () => void
}) {
  if (item.kind === 'question') {
    return (
      <article className="transcript-card question-transcript-card">
        <div className="transcript-avatar question-avatar">Q</div>
        <button className="question-transcript-main" type="button" onClick={onPresent}>
          <span className="language-code is-ko">내 질문 · 눌러서 크게 보기</span>
          <p className="question-transcript-en">{item.english}</p>
          <p className="question-transcript-ko">{item.korean}</p>
        </button>
        <button className="block-delete" type="button" onClick={onDelete} aria-label="이 질문 블록 삭제">
          <TrashIcon />
        </button>
      </article>
    )
  }

  return (
    <article className="transcript-card">
      <div className="transcript-avatar">AI</div>
      <div className="transcript-content">
        <span className="transcript-speaker-label">{speakerLabel}</span>
        {item.korean ? (
          <p className="korean-copy" lang="ko" aria-live="polite">{item.korean}</p>
        ) : (
          <div className="translation-recovery">
            <p className="korean-copy muted"><TranslationCopy state={item.translationState} status={status} /></p>
            {(item.translationState === 'error' || item.translationState === 'waiting') && onRetry && (
              <button className="translation-retry" type="button" onClick={onRetry}>다시 번역
              </button>
            )}
          </div>
        )}
        <div className="translation-divider" />
        <p className="english-copy" lang="en">{item.english}</p>
      </div>
      <button className="block-delete" type="button" onClick={onDelete} aria-label="이 번역 블록 삭제">
        <TrashIcon />
      </button>
    </article>
  )
}

function LiveTypingCard({ activityLength }: { activityLength: number }) {
  return (
    <article className="transcript-card live-typing-card" aria-label="말을 듣고 있습니다">
      <div className="transcript-avatar">•••</div>
      <div className="typing-content" aria-hidden="true">
        <div className="typing-label"><span /> 영어를 듣고 있어요</div>
        <i style={{ width: `${Math.min(92, Math.max(42, activityLength))}%` }} />
        <i style={{ width: `${Math.min(74, Math.max(28, activityLength * 0.68))}%` }} />
        <i className="typing-caret" />
      </div>
      <span className="sr-only" aria-live="polite">영어 음성을 듣고 있습니다.</span>
    </article>
  )
}

function EmptyTranscript() {
  return (
    <div className="empty-state">
      <div className="empty-orbit"><span /><span /><span /></div>
      <h3>영어 대화를 시작해 보세요</h3>
      <p>말하는 동안에는 타이핑 표시가 나타나고, 확정된 구간만 한 번 번역됩니다.</p>
    </div>
  )
}

function PresentationDialog({ payload, onClose }: { payload: PresentationPayload; onClose: () => void }) {
  const chunks = splitEnglishForPresentation(payload.en)
  const textDensity = payload.en.length > 220
    ? 'is-long'
    : payload.en.length > 110
      ? 'is-medium'
      : 'is-short'
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        if (!buttons?.length) return
        const first = buttons[0]
        const last = buttons[buttons.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      if (event.key === 'Escape' || (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement))) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', closeWithKeyboard)
    return () => window.removeEventListener('keydown', closeWithKeyboard)
  }, [onClose])

  return (
    <div
      className="presentation-backdrop"
      role="presentation"
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      onMouseDown={onClose}
    >
      <section
        ref={dialogRef}
        className="presentation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="presentation-title"
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="presentation-topline">
          <span id="presentation-title">{payload.label}</span>
          <button type="button" onClick={onClose} autoFocus aria-label="발표 화면 닫기"><ToolIcon name="close" /></button>
        </div>
        <p className="presentation-korean">{payload.ko}</p>
        <div className={`presentation-english ${textDensity}`}>
          {chunks.map((chunk, index) => <span key={`${index}-${chunk}`}>{chunk}</span>)}
        </div>
        {(payload.pronunciation || payload.pronunciationLoading) && (
          <div className={`presentation-pronunciation ${payload.pronunciationLoading ? 'is-loading' : ''}`} lang="ko">
            {payload.pronunciationLoading
              ? <p className="presentation-pronunciation-loading" role="status"><span />발음 표기를 만드는 중…</p>
              : <p>{payload.pronunciation}</p>}
          </div>
        )}
        <p className="presentation-hint"><kbd>Enter</kbd> 또는 <kbd>Esc</kbd>를 누르면 닫혀요.</p>
      </section>
    </div>
  )
}

export default function App() {
  const hadStoredWorkspaceRef = useRef(hasStoredWorkspace())
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(() => loadWorkspace())
  const workspaceRef = useRef(workspaceState)
  workspaceRef.current = workspaceState
  const storageConflictRef = useRef(false)
  const interpreterContextIdRef = useRef(workspaceState.activeContextId)
  const initialContextRef = useRef(
    workspaceState.contexts.find((context) => context.id === workspaceState.activeContextId)
      ?? workspaceState.contexts[0],
  )
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarMessage, setSidebarMessage] = useState('')
  const [editingContextId, setEditingContextId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [storageError, setStorageError] = useState('')
  const [databaseError, setDatabaseError] = useState('')
  const [databaseReady, setDatabaseReady] = useState(false)
  const databaseSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const databaseSavedAtRef = useRef<number | null>(null)
  const freshTabInitializedRef = useRef(false)
  const [presentation, setPresentation] = useState<PresentationPayload | null>(null)
  const sidebarToggleRef = useRef<HTMLButtonElement>(null)
  const sidebarCloseRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const presentationOpenerRef = useRef<HTMLElement | null>(null)
  const presentationPronunciationAbortRef = useRef<AbortController | null>(null)
  const presentationPronunciationRequestRef = useRef(0)
  const renameCancelledRef = useRef(false)

  const markRecordingStarted = () => {
    setWorkspaceState((current) => ({
      ...current,
      contexts: current.contexts.map((context) =>
        context.id === current.activeContextId && !context.recordingStartedAt
          ? { ...context, recordingStartedAt: Date.now(), updatedAt: Date.now() }
          : context,
      ),
    }))
  }

  const interpreter = useLiveInterpreter({
    initialSession: initialContextRef.current,
    onRecordingStarted: markRecordingStarted,
  })
  const {
    status,
    segments,
    live,
    questions,
    lastQuestionGeneratedAt,
    error,
    isSpeaking,
    isActive,
    start,
    stop,
    loadSession,
    deleteSegment,
    contextRefining,
    refineContextNow,
  } = interpreter
  const retryTranslation = (interpreter as typeof interpreter & {
    retryTranslation?: (segmentId: string) => void | Promise<void>
  }).retryTranslation
  const interpreterSnapshotRef = useRef({ segments, questions, lastQuestionGeneratedAt })
  interpreterSnapshotRef.current = { segments, questions, lastQuestionGeneratedAt }

  const feedRef = useRef<HTMLDivElement>(null)
  const contentGridRef = useRef<HTMLElement>(null)
  const composerInputRef = useRef<HTMLTextAreaElement>(null)
  const composerAbortRef = useRef<AbortController | null>(null)
  const exportAbortRef = useRef<AbortController | null>(null)
  const exportCheckpointRef = useRef<{
    contextId: string
    signature: string
    nextBatch: number
    parts: string[]
  } | null>(null)
  const composerRequestRef = useRef(0)
  const resizingRef = useRef(false)
  const resizeAbortRef = useRef<AbortController | null>(null)
  const [questionPaneWidth, setQuestionPaneWidth] = useState(390)
  const [isResizing, setIsResizing] = useState(false)
  const [composerMode, setComposerMode] = useState<ComposerMode>('direct')
  const [koreanDraft, setKoreanDraft] = useState('')
  const [englishDraft, setEnglishDraft] = useState('')
  const [pronunciationDraft, setPronunciationDraft] = useState('')
  const [composerStage, setComposerStage] = useState<ComposerStage>('idle')
  const [composerError, setComposerError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState('')
  const [selectedPreparedSlot, setSelectedPreparedSlot] = useState(1)
  const [relativeTimeNow, setRelativeTimeNow] = useState(() => Date.now())

  useEffect(() => () => resizeAbortRef.current?.abort(), [])

  const activeContext = useMemo(
    () => workspaceState.contexts.find(
      (context) => context.id === workspaceState.activeContextId,
    ) ?? workspaceState.contexts[0],
    [workspaceState.activeContextId, workspaceState.contexts],
  )
  const { preparedSlots, visiblePreparedSlots } = useMemo(() => {
    const slots = arrangePreparedQuestionSlots(activeContext.preparedQuestions)
    const visible = slots.slice(0, 6)
    return {
      preparedSlots: slots,
      visiblePreparedSlots: visible,
    }
  }, [activeContext.preparedQuestions])
  const selectedPreparedQuestion = preparedSlots[selectedPreparedSlot - 1]?.question ?? null
  const transcriptSpeakerLabel = '발화자 정보 없음'
  const sortedContexts = useMemo(
    () => sortContextsByRecent(workspaceState.contexts),
    [workspaceState.contexts],
  )

  useEffect(() => {
    const timer = window.setInterval(() => setRelativeTimeNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setSelectedPreparedSlot((current) => Math.min(current, 6))
  }, [activeContext.id])

  useEffect(() => {
    if (!activeContext.recordingStartedAt) return
    const elapsed = Math.max(0, Date.now() - activeContext.recordingStartedAt)
    const firstDelay = CONTEXT_REFINEMENT_INTERVAL_MS
      - (elapsed % CONTEXT_REFINEMENT_INTERVAL_MS)
    let interval: number | undefined
    const timeout = window.setTimeout(() => {
      void refineContextNow()
      interval = window.setInterval(() => void refineContextNow(), CONTEXT_REFINEMENT_INTERVAL_MS)
    }, firstDelay)
    return () => {
      window.clearTimeout(timeout)
      if (interval) window.clearInterval(interval)
    }
  }, [activeContext.id, activeContext.recordingStartedAt, refineContextNow])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const snapshot = await loadWorkspaceFromDatabase(controller.signal)
        databaseSavedAtRef.current = snapshot.savedAt
        if (!snapshot.workspace) return
        const restored = parseWorkspace(snapshot.workspace)
        if (!restored) throw new Error('저장된 DB 형식이 올바르지 않습니다.')
        const resolved = hadStoredWorkspaceRef.current
          ? mergeWorkspaceSources(restored, workspaceRef.current)
          : restored
        const restoredContext = resolved.contexts.find(
          (context) => context.id === resolved.activeContextId,
        ) ?? resolved.contexts[0]
        if (!loadSession(restoredContext)) return

        interpreterContextIdRef.current = restoredContext.id
        interpreterSnapshotRef.current = {
          segments: restoredContext.segments,
          questions: restoredContext.questions,
          lastQuestionGeneratedAt: restoredContext.lastQuestionGeneratedAt,
        }
        workspaceRef.current = resolved
        setWorkspaceState(resolved)
        setStorageError(saveWorkspace(resolved) ?? '')
      } catch (databaseLoadError) {
        if (!controller.signal.aborted) {
          setDatabaseError(
            databaseLoadError instanceof Error
              ? `로컬 DB 복원 실패: ${databaseLoadError.message}`
              : '로컬 DB를 복원하지 못했습니다.',
          )
        }
      } finally {
        if (!controller.signal.aborted) setDatabaseReady(true)
      }
    })()
    return () => controller.abort()
  }, [loadSession])

  useEffect(() => {
    if (!databaseReady || freshTabInitializedRef.current) return
    freshTabInitializedRef.current = true
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    if (navigation?.type && navigation.type !== 'navigate') return

    const currentWorkspace = mergeInterpreterSnapshot(
      workspaceRef.current,
      interpreterContextIdRef.current,
      interpreterSnapshotRef.current,
      Date.now(),
    )
    const nextWorkspace = openFreshTabContext(currentWorkspace)
    if (nextWorkspace === currentWorkspace) return
    const nextContext = nextWorkspace.contexts.find(
      (context) => context.id === nextWorkspace.activeContextId,
    )
    if (!nextContext || !loadSession(nextContext)) return

    interpreterContextIdRef.current = nextContext.id
    interpreterSnapshotRef.current = {
      segments: nextContext.segments,
      questions: nextContext.questions,
      lastQuestionGeneratedAt: nextContext.lastQuestionGeneratedAt,
    }
    workspaceRef.current = nextWorkspace
    setWorkspaceState(nextWorkspace)
  }, [databaseReady, loadSession])

  useEffect(() => {
    setWorkspaceState((current) => mergeInterpreterSnapshot(
      current,
      interpreterContextIdRef.current,
      { segments, questions, lastQuestionGeneratedAt },
      Date.now(),
    ))
  }, [lastQuestionGeneratedAt, questions, segments])

  useEffect(() => {
    if (!databaseReady) return
    const timer = window.setTimeout(() => {
      if (storageConflictRef.current) return
      setStorageError(saveWorkspace(workspaceState) ?? '')
      databaseSaveQueueRef.current = databaseSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            databaseSavedAtRef.current = await saveWorkspaceToDatabase(
              workspaceState,
              databaseSavedAtRef.current,
            )
            setDatabaseError('')
          } catch (databaseSaveError) {
            if (
              databaseSaveError instanceof Error
              && databaseSaveError.message.includes('다른 탭에서 로컬 DB가 먼저 변경')
            ) {
              storageConflictRef.current = true
            }
            setDatabaseError(
              databaseSaveError instanceof Error
                ? `로컬 DB 저장 실패: ${databaseSaveError.message}`
                : '로컬 DB에 자동 저장하지 못했습니다.',
            )
          }
        })
    }, 220)
    return () => window.clearTimeout(timer)
  }, [databaseReady, workspaceState])

  useEffect(() => {
    const flushWorkspace = () => {
      if (storageConflictRef.current) return
      const snapshot = interpreterSnapshotRef.current
      const merged = mergeInterpreterSnapshot(
        workspaceRef.current,
        interpreterContextIdRef.current,
        snapshot,
        Date.now(),
      )
      saveWorkspace(merged)
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flushWorkspace()
    }
    window.addEventListener('pagehide', flushWorkspace)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flushWorkspace)
      document.removeEventListener('visibilitychange', flushWhenHidden)
    }
  }, [])

  useEffect(() => {
    const handleExternalWorkspace = (event: StorageEvent) => {
      if (event.key !== WORKSPACE_STORAGE_KEY || !event.newValue) return
      if (event.newValue === JSON.stringify(workspaceRef.current)) return
      storageConflictRef.current = true
      setStorageError('다른 탭에서 이 컨텍스트가 변경됐습니다. 덮어쓰기를 막았습니다. 이 탭을 새로고침해 최신 내용을 불러오세요.')
    }
    window.addEventListener('storage', handleExternalWorkspace)
    return () => window.removeEventListener('storage', handleExternalWorkspace)
  }, [])

  useEffect(() => {
    if (!sidebarOpen) return
    const region = sidebarRef.current
    const focusables = region?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    focusables?.[0]?.focus()
    const handleSidebarKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setSidebarOpen(false)
        window.setTimeout(() => sidebarToggleRef.current?.focus(), 0)
        return
      }
      if (event.key !== 'Tab' || !focusables?.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleSidebarKeyboard)
    return () => window.removeEventListener('keydown', handleSidebarKeyboard)
  }, [sidebarOpen])

  useEffect(() => {
    const feed = feedRef.current
    if (!feed) return
    const distanceFromBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight
    if (distanceFromBottom < 180) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' })
  }, [live, segments])

  useEffect(() => () => {
    composerAbortRef.current?.abort()
    exportAbortRef.current?.abort()
    presentationPronunciationAbortRef.current?.abort()
  }, [])

  const updateActiveContext = (updater: (context: ConversationContext) => ConversationContext) => {
    setWorkspaceState((current) => ({
      ...current,
      contexts: current.contexts.map((context) =>
        context.id === current.activeContextId ? updater(context) : context,
      ),
    }))
  }

  const selectContext = (context: ConversationContext) => {
    if (isActive || status === 'stopping') {
      setSidebarMessage('녹음을 일시 정지한 뒤 다른 컨텍스트로 이동할 수 있어요.')
      return
    }
    composerAbortRef.current?.abort()
    composerRequestRef.current += 1
    setComposerMode('direct')
    setKoreanDraft('')
    setEnglishDraft('')
    setPronunciationDraft('')
    setComposerStage('idle')
    setPresentation(null)
    const currentWorkspace = mergeInterpreterSnapshot(
      workspaceRef.current,
      interpreterContextIdRef.current,
      interpreterSnapshotRef.current,
      Date.now(),
    )
    const target = currentWorkspace.contexts.find((candidate) => candidate.id === context.id)
    if (!target || !loadSession(target)) return
    const nextWorkspace = { ...currentWorkspace, activeContextId: target.id }
    interpreterSnapshotRef.current = {
      segments: target.segments,
      questions: target.questions,
      lastQuestionGeneratedAt: target.lastQuestionGeneratedAt,
    }
    interpreterContextIdRef.current = target.id
    workspaceRef.current = nextWorkspace
    setWorkspaceState(nextWorkspace)
    setSidebarOpen(false)
    setSidebarMessage('')
  }

  const createContext = () => {
    if (isActive || status === 'stopping') {
      setSidebarMessage('녹음을 일시 정지한 뒤 새 컨텍스트를 만들 수 있어요.')
      return
    }
    composerAbortRef.current?.abort()
    composerRequestRef.current += 1
    setComposerMode('direct')
    setKoreanDraft('')
    setEnglishDraft('')
    setPronunciationDraft('')
    setComposerStage('idle')
    setPresentation(null)
    const currentWorkspace = mergeInterpreterSnapshot(
      workspaceRef.current,
      interpreterContextIdRef.current,
      interpreterSnapshotRef.current,
      Date.now(),
    )
    const next = createConversationContext(currentWorkspace.contexts.length + 1)
    if (!loadSession(next)) return
    const nextWorkspace: WorkspaceState = {
      ...currentWorkspace,
      activeContextId: next.id,
      contexts: [next, ...currentWorkspace.contexts],
    }
    interpreterSnapshotRef.current = {
      segments: next.segments,
      questions: next.questions,
      lastQuestionGeneratedAt: next.lastQuestionGeneratedAt,
    }
    interpreterContextIdRef.current = next.id
    workspaceRef.current = nextWorkspace
    setWorkspaceState(nextWorkspace)
    setSidebarMessage('')
  }

  const deleteContext = (context: ConversationContext) => {
    if (isActive || status === 'stopping') {
      setSidebarMessage('녹음을 일시 정지한 뒤 컨텍스트를 삭제할 수 있어요.')
      return
    }
    if (workspaceRef.current.contexts.length <= 1) {
      setSidebarMessage('마지막 컨텍스트는 삭제할 수 없어요.')
      return
    }
    if (!window.confirm(`“${context.title}” 컨텍스트와 저장된 대화를 삭제할까요?`)) return

    const currentWorkspace = mergeInterpreterSnapshot(
      workspaceRef.current,
      interpreterContextIdRef.current,
      interpreterSnapshotRef.current,
      Date.now(),
    )
    const nextWorkspace = removeConversationContext(currentWorkspace, context.id)
    if (!nextWorkspace) {
      setSidebarMessage('이 컨텍스트를 삭제할 수 없어요.')
      return
    }

    if (context.id === currentWorkspace.activeContextId) {
      const target = nextWorkspace.contexts.find(
        (candidate) => candidate.id === nextWorkspace.activeContextId,
      )
      composerAbortRef.current?.abort()
      composerRequestRef.current += 1
      setComposerMode('direct')
      setKoreanDraft('')
      setEnglishDraft('')
      setPronunciationDraft('')
      setComposerStage('idle')
      setPresentation(null)
      if (!target || !loadSession(target)) return
      interpreterSnapshotRef.current = {
        segments: target.segments,
        questions: target.questions,
        lastQuestionGeneratedAt: target.lastQuestionGeneratedAt,
      }
      interpreterContextIdRef.current = target.id
    }
    if (editingContextId === context.id) setEditingContextId(null)
    workspaceRef.current = nextWorkspace
    setWorkspaceState(nextWorkspace)
    setSidebarMessage('')
  }

  const beginRename = (context: ConversationContext) => {
    renameCancelledRef.current = false
    setEditingContextId(context.id)
    setTitleDraft(context.title)
  }

  const finishRename = (contextId: string, cancel = false) => {
    const shouldCancel = cancel || renameCancelledRef.current
    if (!shouldCancel && titleDraft.trim()) {
      setWorkspaceState((current) => ({
        ...current,
        contexts: current.contexts.map((context) =>
          context.id === contextId
            ? { ...context, title: titleDraft.trim().slice(0, 80), updatedAt: Date.now() }
            : context,
        ),
      }))
    }
    renameCancelledRef.current = false
    setEditingContextId(null)
  }

  const selectPreparedSlot = (slotNumber: number) => {
    const question = preparedSlots[slotNumber - 1]?.question
    composerAbortRef.current?.abort()
    composerRequestRef.current += 1
    setComposerMode('prepared')
    setSelectedPreparedSlot(slotNumber)
    setKoreanDraft(question?.ko ?? '')
    setEnglishDraft(question?.en ?? '')
    setPronunciationDraft(questionPronunciation(question))
    setComposerStage(question ? 'final' : 'idle')
    setComposerError('')
    window.setTimeout(() => composerInputRef.current?.focus(), 0)
  }

  const translateComposedQuestion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const korean = koreanDraft.trim()
    if (!korean || composerStage === 'loading') return
    composerAbortRef.current?.abort()
    const controller = new AbortController()
    const requestId = ++composerRequestRef.current
    composerAbortRef.current = controller
    setEnglishDraft('')
    setPronunciationDraft('')
    setComposerError('')
    setComposerStage('loading')
    try {
      const result: unknown = await polishQuestionDetailed(korean, controller.signal)
      const polished = normalizePolishedQuestion(result)
      if (!polished.english) throw new Error('Question translation was empty')
      if (requestId === composerRequestRef.current && !controller.signal.aborted) {
        setEnglishDraft(polished.english)
        setPronunciationDraft(polished.pronunciation)
        setComposerStage('final')
      }
    } catch {
      if (!controller.signal.aborted && requestId === composerRequestRef.current) {
        setComposerStage('error')
        setComposerError('질문을 번역하지 못했습니다. 잠시 후 다시 시도해 주세요.')
      }
    }
  }

  const saveComposedQuestion = () => {
    const ko = koreanDraft.trim()
    const en = englishDraft.trim()
    if (!ko || !en || composerStage !== 'final') return
    if (composerMode === 'prepared') {
      const prepared: PreparedQuestion = {
        id: selectedPreparedQuestion?.id ?? makeId('prepared'),
        slot: selectedPreparedSlot,
        ko,
        en,
        createdAt: selectedPreparedQuestion?.createdAt ?? Date.now(),
        ...(pronunciationDraft ? { pronunciation: pronunciationDraft } : {}),
        ...(pronunciationDraft ? { pronunciationEnglish: en } : {}),
      }
      updateActiveContext((context) => ({
        ...context,
        preparedQuestions: upsertPreparedQuestionSlot(
          context.preparedQuestions,
          selectedPreparedSlot,
          prepared,
        ),
        updatedAt: Date.now(),
      }))
      setComposerError('')
      return
    } else {
      presentQuestion('Q Translate', { ko, en, pronunciation: pronunciationDraft })
    }
  }

  const presentQuestion = (
    label: string,
    question: Pick<FollowupQuestion, 'ko' | 'en'> & { pronunciation?: string },
  ) => {
    presentationPronunciationAbortRef.current?.abort()
    presentationPronunciationRequestRef.current += 1
    presentationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setPresentation({
      label,
      ko: question.ko,
      en: question.en,
      pronunciation: question.pronunciation,
    })
  }

  const presentStoredQuestion = async (slotNumber: number, question: PreparedQuestion) => {
    const pronunciation = questionPronunciation(question)
    const pronunciationMatches = Boolean(
      pronunciation
      && question.pronunciationEnglish?.replace(/\s+/g, ' ').trim() === question.en.replace(/\s+/g, ' ').trim(),
    )
    if (pronunciationMatches) {
      presentQuestion(`Q storage ${slotNumber}`, { ...question, pronunciation })
      return
    }

    presentationPronunciationAbortRef.current?.abort()
    const controller = new AbortController()
    presentationPronunciationAbortRef.current = controller
    const requestId = ++presentationPronunciationRequestRef.current
    const contextId = activeContext.id
    const sourceKey = `${contextId}:${slotNumber}:${question.id}`
    presentationOpenerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setPresentation({
      label: `Q storage ${slotNumber}`,
      ko: question.ko,
      en: question.en,
      pronunciationLoading: true,
      sourceKey,
    })

    try {
      const nextPronunciation = await generateEnglishPronunciation(question.en, controller.signal)
      if (controller.signal.aborted || requestId !== presentationPronunciationRequestRef.current) return
      const latestWorkspace = workspaceRef.current
      if (latestWorkspace.activeContextId !== contextId) return
      const latestContext = latestWorkspace.contexts.find((context) => context.id === contextId)
      const latestQuestion = latestContext
        ? arrangePreparedQuestionSlots(latestContext.preparedQuestions)[slotNumber - 1]?.question
        : null
      if (
        !latestQuestion
        || latestQuestion.id !== question.id
        || latestQuestion.en.replace(/\s+/g, ' ').trim() !== question.en.replace(/\s+/g, ' ').trim()
      ) return

      if (nextPronunciation) {
        setWorkspaceState((current) => ({
          ...current,
          contexts: current.contexts.map((context) => context.id === contextId
            ? {
                ...context,
                preparedQuestions: context.preparedQuestions.map((candidate) => candidate.id === question.id
                  ? {
                      ...candidate,
                      pronunciation: nextPronunciation,
                      pronunciationEnglish: question.en,
                    }
                  : candidate),
                updatedAt: Date.now(),
              }
            : context),
        }))
      }
      setPresentation((current) => current?.sourceKey === sourceKey
        ? { ...current, pronunciation: nextPronunciation || undefined, pronunciationLoading: false }
        : current)
    } catch {
      if (!controller.signal.aborted && requestId === presentationPronunciationRequestRef.current) {
        setPresentation((current) => current?.sourceKey === sourceKey
          ? { ...current, pronunciationLoading: false }
          : current)
      }
    } finally {
      if (presentationPronunciationAbortRef.current === controller) {
        presentationPronunciationAbortRef.current = null
      }
    }
  }

  const closePresentation = () => {
    presentationPronunciationAbortRef.current?.abort()
    presentationPronunciationRequestRef.current += 1
    setPresentation(null)
    window.setTimeout(() => presentationOpenerRef.current?.focus(), 0)
  }

  const clearPreparedSlot = (slotNumber: number) => {
    const question = preparedSlots[slotNumber - 1]?.question
    if (!question) return
    if (!window.confirm(`${slotNumber}번 Q storage 질문을 삭제할까요?`)) return
    updateActiveContext((context) => ({
      ...context,
      preparedQuestions: clearPreparedQuestionSlot(
        context.preparedQuestions,
        slotNumber,
      ),
      updatedAt: Date.now(),
    }))
    if (selectedPreparedSlot === slotNumber) {
      setKoreanDraft('')
      setEnglishDraft('')
      setPronunciationDraft('')
      setComposerStage('idle')
      setComposerError('')
    }
  }

  const currentSnapshot = (): ConversationContext => ({
    ...activeContext,
    segments,
    questions,
    lastQuestionGeneratedAt,
  })

  const downloadText = (snapshot: ConversationContext, content: string) => {
    const blob = new Blob([`\uFEFF${content}`], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = textFilename(snapshot)
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const exportRawText = () => {
    const snapshot = currentSnapshot()
    const content = rawChatText(snapshot)
    if (!content) return
    downloadText(snapshot, content)
    setExportError('')
  }

  const exportText = async () => {
    const snapshot = currentSnapshot()
    const batches = exportBatches(snapshot.segments)
    if (!batches.length || exporting) return
    const signature = `missing-translation-recovery-v2:${JSON.stringify(batches)}`
    let checkpoint = exportCheckpointRef.current
    if (
      !checkpoint
      || checkpoint.contextId !== snapshot.id
      || checkpoint.signature !== signature
      || checkpoint.nextBatch > batches.length
    ) {
      checkpoint = { contextId: snapshot.id, signature, nextBatch: 0, parts: [] }
      exportCheckpointRef.current = checkpoint
    }
    exportAbortRef.current?.abort()
    const controller = new AbortController()
    exportAbortRef.current = controller
    setExporting(true)
    setExportProgress(checkpoint.nextBatch
      ? Math.round((checkpoint.nextBatch / batches.length) * 94)
      : 5)
    setExportError('')
    try {
      for (let index = checkpoint.nextBatch; index < batches.length; index += 1) {
        checkpoint.parts.push(await exportChatText(batches[index], controller.signal))
        checkpoint.nextBatch = index + 1
        setExportProgress(Math.round(((index + 1) / batches.length) * 94))
      }
      if (controller.signal.aborted) return
      downloadText(snapshot, combineBilingualExportParts(checkpoint.parts))
      exportCheckpointRef.current = null
      setExportProgress(100)
      await new Promise((resolve) => window.setTimeout(resolve, 280))
    } catch (exportFailure) {
      if (!controller.signal.aborted) {
        setExportError(
          exportFailure instanceof Error
            ? `Chat Text 생성 실패: ${exportFailure.message}`
            : 'Chat Text를 만들지 못했습니다.',
        )
      }
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null
      if (!controller.signal.aborted) {
        setExporting(false)
        setExportProgress(0)
      }
    }
  }

  const resizeQuestionPane = (clientX: number) => {
    const grid = contentGridRef.current
    if (!grid) return
    const rect = grid.getBoundingClientRect()
    const maximum = Math.min(560, rect.width * 0.52)
    setQuestionPaneWidth(Math.round(Math.min(maximum, Math.max(310, rect.right - clientX))))
  }

  const finishResize = () => {
    resizingRef.current = false
    setIsResizing(false)
    resizeAbortRef.current?.abort()
    resizeAbortRef.current = null
  }

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeAbortRef.current?.abort()
    const controller = new AbortController()
    resizeAbortRef.current = controller
    resizingRef.current = true
    setIsResizing(true)
    event.currentTarget.focus({ preventScroll: true })
    resizeQuestionPane(event.clientX)
    const move = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return
      moveEvent.preventDefault()
      resizeQuestionPane(moveEvent.clientX)
    }
    window.addEventListener('pointermove', move, { signal: controller.signal })
    window.addEventListener('pointerup', finishResize, { signal: controller.signal, once: true })
    window.addEventListener('pointercancel', finishResize, { signal: controller.signal, once: true })
  }
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setQuestionPaneWidth((current) => Math.min(560, Math.max(310, current + (event.key === 'ArrowLeft' ? 24 : -24))))
  }

  const hasTranscript = Boolean(segments.length || live)
  const disabled = status === 'stopping'
  const micProgress = ({
    idle: 0,
    'requesting-permission': 26,
    connecting: 54,
    listening: 100,
    reconnecting: 68,
    stopping: 86,
    stopped: 0,
    error: 0,
  } satisfies Record<ConnectionState, number>)[status]
  return (
    <div className="app-frame">
      <svg className="logo-color-filter" aria-hidden="true" focusable="false">
        <defs>
          <filter id="aiyk-purple-filter" colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0.365
                      0 0 0 0 0.310
                      0 0 0 0 0.824
                     -0.333 -0.333 -0.333 0 1"
            />
            <feComponentTransfer>
              <feFuncA type="linear" slope="1.35" intercept="-0.14" />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>
      <div
        className={`sidebar-backdrop ${sidebarOpen ? 'is-open' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <aside ref={sidebarRef} className={`context-sidebar ${sidebarOpen ? 'is-open' : ''}`} inert={!sidebarOpen ? true : undefined} aria-hidden={!sidebarOpen} role="dialog" aria-modal="true" aria-label="대화 컨텍스트">
        <div className="sidebar-brand"><BrandLogo /><button ref={sidebarCloseRef} type="button" onClick={() => { setSidebarOpen(false); window.setTimeout(() => sidebarToggleRef.current?.focus(), 0) }} aria-label="사이드바 닫기"><ToolIcon name="close" /></button></div>
        <button className="new-context-button" type="button" onClick={createContext}><ToolIcon name="prepared" />New context</button>
        {sidebarMessage && <p className="sidebar-message" role="status">{sidebarMessage}</p>}
        <nav className="context-list" aria-label="대화 컨텍스트">
          {sortedContexts.map((context) => (
            <div className={`context-row ${context.id === workspaceState.activeContextId ? 'is-active' : ''}`} key={context.id}>
              {editingContextId === context.id ? (
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => finishRename(context.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      finishRename(context.id)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      renameCancelledRef.current = true
                      finishRename(context.id, true)
                    }
                  }}
                  autoFocus
                  maxLength={80}
                  aria-label="컨텍스트 제목"
                />
              ) : (
                <button className="context-select" type="button" onClick={() => selectContext(context)} aria-current={context.id === workspaceState.activeContextId ? 'page' : undefined}>
                  <strong>{context.title}</strong>
                  <time
                    dateTime={new Date(context.updatedAt).toISOString()}
                    title={`마지막 수정 ${new Date(context.updatedAt).toLocaleString('ko-KR')}`}
                  >
                    {formatRelativeUpdatedAt(context.updatedAt, relativeTimeNow)}
                  </time>
                </button>
              )}
              <button className="context-rename" type="button" onClick={() => beginRename(context)} aria-label={`${context.title} 제목 수정`}><ToolIcon name="edit" /></button>
              <button className="context-delete" type="button" onClick={() => deleteContext(context)} aria-label={`${context.title} 컨텍스트 삭제`}><TrashIcon /></button>
            </div>
          ))}
        </nav>
        <p className="sidebar-privacy">이 기기의 로컬 DB에 자동 저장됩니다.</p>
      </aside>

      <div className="app-shell" inert={sidebarOpen || Boolean(presentation) ? true : undefined}>
        <header className="topbar">
          <div className="brand-lockup">
            <button ref={sidebarToggleRef} className="sidebar-toggle" type="button" onClick={() => setSidebarOpen(true)} aria-expanded={sidebarOpen} aria-label="컨텍스트 사이드바 열기"><ToolIcon name="menu" /></button>
            <BrandLogo />
          </div>
          {editingContextId === activeContext.id ? (
            <input
              className="topbar-context-input"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => finishRename(activeContext.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  finishRename(activeContext.id)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  renameCancelledRef.current = true
                  finishRename(activeContext.id, true)
                }
              }}
              autoFocus
              maxLength={80}
              aria-label="현재 컨텍스트 이름 수정"
            />
          ) : (
            <button className="topbar-context-title" type="button" onClick={() => beginRename(activeContext)} title="클릭해서 컨텍스트 이름 수정">
              {activeContext.title}
            </button>
          )}
          <div className="header-meta">
            <button className="text-export-button" type="button" onClick={() => void exportText()} disabled={exporting || !segments.some((segment) => segment.kind === 'transcript')} aria-label={exporting ? `Chat Text 생성 ${exportProgress}%` : 'Chat Text 다운로드'}><ToolIcon name="export" /><span>{exporting ? `${exportProgress}%` : 'Text'}</span></button>
            <StatusPill status={status} />
          </div>
        </header>

        <main className="workspace">
          {(error || storageError || databaseError) && (
            <div className="error-banner" role="alert"><span>!</span><p>{error || storageError || databaseError}</p></div>
          )}
          {exportError && (
            <div className="error-banner export-error-banner" role="alert">
              <span>!</span><p>{exportError}</p>
              <div className="export-error-actions">
                <button type="button" onClick={() => void exportText()}>다시 시도</button>
                <button type="button" onClick={exportRawText}>원문 Text</button>
              </div>
            </div>
          )}
          {exporting && (
            <div className="export-progress-panel" role="progressbar" aria-label="Chat Text 생성 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={exportProgress}>
              <div><strong>누락 번역을 확인하는 중</strong><span>{exportProgress}%</span></div>
              <i><b style={{ width: `${exportProgress}%` }} /></i>
            </div>
          )}
          <section className={`content-grid ${isResizing ? 'is-resizing' : ''}`} ref={contentGridRef} style={{ '--question-pane-width': `${questionPaneWidth}px` } as CSSProperties}>
            <div className="clay-panel transcript-panel">
              <div className="panel-heading">
                <div><h2>Chat{contextRefining && <small className="refinement-progress" role="status" aria-label="대화 정리 중">정리 중</small>}</h2></div>
              </div>
              <div className="transcript-feed" ref={feedRef}>
                {!hasTranscript && <EmptyTranscript />}
                {segments.map((segment) => (
                  <TranscriptCard
                    key={segment.id}
                    item={segment}
                    status={status}
                    speakerLabel={segment.speaker || transcriptSpeakerLabel}
                    onDelete={() => deleteSegment(segment.id)}
                    onPresent={() => presentQuestion('내 질문', { ko: segment.korean, en: segment.english })}
                    onRetry={segment.kind === 'transcript' && retryTranslation
                      ? () => void retryTranslation(segment.id)
                      : undefined}
                  />
                ))}
                {live && <LiveTypingCard activityLength={live.activityLength} />}
              </div>
            </div>

            <aside className="clay-panel questions-panel">
              <div className="pane-resizer" role="separator" aria-label="대화와 질문 영역 너비 조절" aria-orientation="vertical" aria-valuemin={310} aria-valuemax={560} aria-valuenow={questionPaneWidth} tabIndex={0} onPointerDown={startResize} onDoubleClick={() => setQuestionPaneWidth(390)} onKeyDown={resizeWithKeyboard}><span /><span /><span /></div>
              <div className="questions-panel-content">
              <div className="panel-heading question-heading">
                <div><h2>Q Translate</h2></div>
              </div>

              <form className="question-composer q-translate-composer" id="question-composer" onSubmit={(event) => void translateComposedQuestion(event)}>
                <label htmlFor="korean-question">
                  {composerMode === 'prepared' ? `${selectedPreparedSlot}번 슬롯 한국어 질문` : '한국어 질문'}
                </label>
                <textarea
                  id="korean-question"
                  ref={composerInputRef}
                  value={koreanDraft}
                  onChange={(event) => {
                    composerAbortRef.current?.abort()
                    composerRequestRef.current += 1
                    setKoreanDraft(event.target.value)
                    setEnglishDraft('')
                    setPronunciationDraft('')
                    setComposerStage('idle')
                    setComposerError('')
                  }}
                  placeholder="예: 이 주장을 뒷받침하는 핵심 근거를 설명해 주시겠습니까?"
                  rows={4}
                  maxLength={2_000}
                />
                <button className="composer-submit" type="submit" disabled={!koreanDraft.trim() || composerStage === 'loading'}>
                  {composerStage === 'loading'
                    ? '학술적 영어로 번역 중…'
                    : '공손한 영어 질문 만들기 →'}
                </button>
                {(englishDraft || composerError) && (
                  <div className={`composer-result ${composerStage === 'error' ? 'has-error' : ''}`}>
                    <span>{composerStage === 'final' ? 'POLISHED ENGLISH' : 'FAST DRAFT'}</span>
                    <p lang="en">{englishDraft || composerError}</p>
                    {pronunciationDraft && (
                      <div className="pronunciation-guide">
                        <p lang="ko">{pronunciationDraft}</p>
                      </div>
                    )}
                    {composerError && englishDraft && <small>{composerError}</small>}
                    <button type="button" onClick={saveComposedQuestion} disabled={composerStage !== 'final'}>
                      {composerMode === 'prepared'
                        ? `${selectedPreparedSlot}번 슬롯 ${selectedPreparedQuestion ? '수정 저장' : '등록'}`
                        : '크게 보기'}
                    </button>
                  </div>
                )}
              </form>

              <section className="prepared-slot-picker q-translate-slots" aria-label="Q storage">
                <div className="prepared-slot-heading">
                  <div>
                    <strong>Q storage</strong>
                    <span>질문을 눌러 크게 보거나, 별도 버튼으로 수정·삭제하세요.</span>
                  </div>
                  <div className="q-storage-count" aria-label="Q storage 6개 슬롯"><span>6 slots</span></div>
                </div>
                <div className="prepared-slot-grid">
                  {visiblePreparedSlots.map((slot) => {
                    const selected = composerMode === 'prepared' && slot.number === selectedPreparedSlot
                    return (
                      <div className={`prepared-slot-entry ${selected ? 'is-selected' : ''} ${slot.question ? 'is-filled' : ''}`} key={slot.number}>
                        <button
                          className="prepared-slot-select"
                          type="button"
                          onClick={() => slot.question
                            ? void presentStoredQuestion(slot.number, slot.question)
                            : selectPreparedSlot(slot.number)}
                          aria-pressed={selected}
                          aria-label={`${slot.number}번 Q storage, ${summarizePreparedQuestion(slot.question)}${slot.question ? ', 크게 보기' : ', 등록하기'}`}
                        >
                          <b>{slot.number}</b>
                          <span>{summarizePreparedQuestion(slot.question)}</span>
                        </button>
                        {slot.question && (
                          <div className="prepared-slot-actions">
                            <button className="prepared-slot-edit" type="button" onClick={() => selectPreparedSlot(slot.number)} aria-label={`${slot.number}번 Q storage 수정`}>수정</button>
                            <button className="prepared-slot-remove" type="button" onClick={() => clearPreparedSlot(slot.number)} aria-label={`${slot.number}번 Q storage 삭제`} title={`${slot.number}번 Q storage 삭제`}><TrashIcon /></button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
              </div>
            </aside>
          </section>
        </main>

        <div className={`mic-dock status-${status} ${isActive ? 'is-active' : ''} ${isSpeaking ? 'is-speaking' : ''}`}>
          <div className="sound-waves" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <button className="mic-button" type="button" aria-pressed={isActive} aria-label={isActive ? '실시간 듣기 멈추기' : '실시간 듣기 시작하기'} disabled={disabled} onClick={() => void (isActive ? stop() : start())}>
            <svg className="mic-circular-progress" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="mic-progress-track" cx="50" cy="50" r="46" pathLength="100" />
              <circle className="mic-progress-value" cx="50" cy="50" r="46" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - micProgress} />
            </svg>
            <span className="mic-ring ring-one" /><span className="mic-ring ring-two" /><span className="mic-face"><MicIcon active={isActive} /></span>
          </button>
          <div className="mic-copy"><strong>{statusCopy[status].label}</strong><span>{statusCopy[status].detail}</span></div>
        </div>
      </div>

      {presentation && <PresentationDialog payload={presentation} onClose={closePresentation} />}
    </div>
  )
}
