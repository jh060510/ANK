import type { AppConfig } from '../types'
import type { WorkspaceState } from './contexts'

export type TranscriptRefineBlock = {
  id: string
  english: string
  korean: string
  speaker?: string
}

export type RefinedTranscriptGroup = {
  sourceIds: string[]
  speaker: string
  english: string
  korean: string
}

export type QuestionTranslationResult = {
  english: string
  pronunciation: string
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return payload
}

export async function getAppConfig(): Promise<AppConfig> {
  const response = await fetch('/api/config', { cache: 'no-store' })
  return readResponse<AppConfig>(response)
}

export async function loadWorkspaceFromDatabase(
  signal?: AbortSignal,
): Promise<{ workspace: unknown | null; savedAt: number | null }> {
  const response = await fetch('/api/workspace', { cache: 'no-store', signal })
  return readResponse<{ workspace: unknown | null; savedAt: number | null }>(response)
}

export async function saveWorkspaceToDatabase(
  workspace: WorkspaceState,
  expectedSavedAt: number | null,
  signal?: AbortSignal,
): Promise<number> {
  const response = await fetch('/api/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ workspace, expectedSavedAt }),
  })
  const payload = await readResponse<{ savedAt: number }>(response)
  return payload.savedAt
}

export async function translate(
  text: string,
  context: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ text, context }),
  })
  const payload = await readResponse<{ translation: string }>(response)
  return payload.translation
}

/** Explicit user-initiated retry path. Server-side provider failover remains
 * authoritative; the separate function keeps UI retry intent auditable. */
export async function retryFailedTranslation(
  text: string,
  context: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ text, context, retry: true }),
  })
  const payload = await readResponse<{ translation: string }>(response)
  return payload.translation
}

export async function polishQuestionDetailed(
  korean: string,
  signal?: AbortSignal,
): Promise<QuestionTranslationResult> {
  const response = await fetch('/api/polish-question', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ korean }),
  })
  return readResponse<QuestionTranslationResult>(response)
}

export async function generateEnglishPronunciation(
  english: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/english-pronunciation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ english }),
  })
  const payload = await readResponse<{ pronunciation: string }>(response)
  return payload.pronunciation
}

export async function refineContext(
  blocks: TranscriptRefineBlock[],
  signal?: AbortSignal,
): Promise<RefinedTranscriptGroup[]> {
  const response = await fetch('/api/refine-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ blocks }),
  })
  const payload = await readResponse<{ groups: RefinedTranscriptGroup[] }>(response)
  return payload.groups
}

export async function exportChatText(
  blocks: TranscriptRefineBlock[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/export-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({ blocks }),
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error || `Request failed (${response.status})`)
  }
  return response.text()
}
