import { describe, expect, it } from 'vitest'

import type { ConversationContext, FollowupQuestion, TranscriptItem } from '../types'
import {
  createConversationContext,
  formatRelativeUpdatedAt,
  MAX_LINKED_PEOPLE,
  MAX_PREPARED_QUESTIONS,
  mergeInterpreterSnapshot,
  mergeWorkspaceSources,
  openFreshTabContext,
  removeConversationContext,
  textFilename,
  parseWorkspace,
  splitEnglishForPresentation,
  sortContextsByRecent,
  type WorkspaceState,
} from './contexts'

const block = (
  id: string,
  kind: TranscriptItem['kind'],
  english: string,
  createdAt: number,
): TranscriptItem => ({
  id,
  kind,
  english,
  korean: `${english}-ko`,
  createdAt,
  translationState: 'ready',
})

describe('conversation contexts', () => {
  it('uses a local date and time instead of a sequence number in new default titles', () => {
    const created = createConversationContext(3)
    expect(created.title).toMatch(/^New context · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(created.title).not.toBe('New context 3')
    expect(created.preparedSlotCount).toBe(6)
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'legacy',
      contexts: [{
        id: 'legacy', title: '새 컨텍스트 4', createdAt: 1, updatedAt: 1,
        segments: [], questions: [], preparedQuestions: [],
      }],
    })
    expect(parsed?.contexts[0].title).toBe('New context 4')
  })

  it('preserves an optional Q storage pronunciation guide', () => {
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'stored',
      contexts: [{
        id: 'stored', title: 'Interview', createdAt: 1, updatedAt: 2,
        segments: [], questions: [], people: [],
        preparedQuestions: [{
          id: 'q1', ko: '질문', en: 'Question?', pronunciation: '퀘스천?', pronunciationEnglish: 'Question?', createdAt: 2,
        }],
      }],
    })
    expect(parsed?.contexts[0].preparedQuestions[0].pronunciation).toBe('퀘스천?')
    expect(parsed?.contexts[0].preparedQuestions[0].pronunciationEnglish).toBe('Question?')
  })

  it('preserves valid refinement watermark and raw provenance during storage parsing', () => {
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'stored',
      contexts: [{
        id: 'stored', title: 'Interview', createdAt: 1, updatedAt: 2,
        questions: [], preparedQuestions: [], people: [],
        segments: [{
          id: 'merged', kind: 'transcript', english: 'refined', korean: '정리됨',
          translationState: 'ready', createdAt: 1, speaker: 'Speaker 1', refinedAt: 2,
          sourceIds: ['raw-a', 'raw-b'], rawEnglish: 'raw a\nraw b', rawKorean: '원문 a\n원문 b',
        }],
      }],
    })
    expect(parsed?.contexts[0].segments[0]).toMatchObject({
      refinedAt: 2,
      sourceIds: ['raw-a', 'raw-b'],
      rawEnglish: 'raw a\nraw b',
    })
  })

  it('opens an existing workspace in a fresh context without duplicating a pristine first visit', () => {
    const pristine: WorkspaceState = {
      schemaVersion: 2,
      activeContextId: 'empty',
      contexts: [{
        id: 'empty', title: 'New context 1', createdAt: 1, updatedAt: 1,
        segments: [], questions: [], preparedQuestions: [], people: [],
      }],
    }
    expect(openFreshTabContext(pristine)).toBe(pristine)

    const used: WorkspaceState = {
      ...pristine,
      contexts: [{ ...pristine.contexts[0], segments: [block('spoken', 'transcript', 'hello', 2)] }],
    }
    const opened = openFreshTabContext(used)
    expect(opened.contexts).toHaveLength(2)
    expect(opened.activeContextId).toBe(opened.contexts[0].id)
    expect(opened.contexts[0].segments).toEqual([])
    expect(opened.contexts[1].segments[0].english).toBe('hello')
  })

  it('merges durable and browser workspaces without dropping either source', () => {
    const durable = createConversationContext(1)
    durable.id = 'durable'
    durable.title = 'Saved interview'
    durable.updatedAt = 20
    durable.segments = [block('saved', 'transcript', 'saved speech', 20)]
    const browser = createConversationContext(2)
    browser.id = 'browser'
    browser.title = 'Browser draft'
    browser.updatedAt = 10
    const merged = mergeWorkspaceSources(
      { schemaVersion: 2, activeContextId: durable.id, contexts: [durable] },
      { schemaVersion: 2, activeContextId: browser.id, contexts: [browser] },
    )
    expect(merged.contexts.map((context) => context.id)).toEqual(['durable', 'browser'])
    expect(merged.contexts[0].segments).toHaveLength(1)
    expect(merged.activeContextId).toBe('durable')
  })

  it('formats relative modified time at useful sidebar thresholds', () => {
    const now = 1_800_000_000_000
    expect(formatRelativeUpdatedAt(now - 30_000, now)).toBe('방금 전 수정')
    expect(formatRelativeUpdatedAt(now - 3 * 60_000, now)).toBe('3분 전 수정')
    expect(formatRelativeUpdatedAt(now - 2 * 3_600_000, now)).toBe('2시간 전 수정')
    expect(formatRelativeUpdatedAt(now - 2 * 86_400_000, now)).toBe('2일 전 수정')
  })

  it('sorts contexts from the most recently modified without mutating storage order', () => {
    const older = createConversationContext(1)
    const newer = createConversationContext(2)
    older.updatedAt = 10
    newer.updatedAt = 20
    const stored = [older, newer]
    expect(sortContextsByRecent(stored).map((context) => context.id)).toEqual([newer.id, older.id])
    expect(stored.map((context) => context.id)).toEqual([older.id, newer.id])
  })

  it('produces a safe text filename', () => {
    const session: ConversationContext = {
      id: 'context',
      title: 'Meeting: one/two',
      createdAt: 1,
      updatedAt: 2,
      segments: [block('a', 'transcript', 'surviving', 1)],
      questions: [],
      preparedQuestions: [],
      people: [],
    }
    expect(textFilename(session)).not.toMatch(/[:/]/)
    expect(textFilename(session)).toMatch(/\.txt$/)
  })

  it('hydrates legacy v2 contexts without people and caps prepared questions at twenty', () => {
    const prepared = Array.from({ length: 22 }, (_, index) => ({
      id: `p-${index}`,
      ko: `질문 ${index}`,
      en: `Question ${index}`,
      createdAt: index,
    }))
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'legacy',
      contexts: [{
        id: 'legacy',
        title: 'Legacy',
        createdAt: 1,
        updatedAt: 1,
        segments: [],
        questions: [],
        preparedQuestions: prepared,
      }],
    })
    expect(parsed?.contexts[0].people).toEqual([])
    expect(parsed?.contexts[0].preparedQuestions).toHaveLength(MAX_PREPARED_QUESTIONS)
    expect(parsed?.contexts[0].preparedQuestions.map((question) => question.id)).toEqual(
      prepared.slice(0, MAX_PREPARED_QUESTIONS).map((question) => question.id),
    )
  })

  it('caps normalized people without dropping the context', () => {
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'people',
      contexts: [{
        id: 'people', title: 'People', createdAt: 1, updatedAt: 1,
        segments: [], questions: [], preparedQuestions: [],
        people: Array.from({ length: MAX_LINKED_PEOPLE + 2 }, (_, index) => ({
          id: `person-${index}`,
          name: `Person ${index}`,
          createdAt: index + 1,
        })),
      }],
    })
    expect(parsed?.contexts[0].people).toHaveLength(MAX_LINKED_PEOPLE)
  })

  it('normalizes an incomplete person without dropping the surrounding conversation', () => {
    const parsed = parseWorkspace({
      schemaVersion: 2,
      activeContextId: 'legacy',
      contexts: [{
        id: 'legacy', title: 'Legacy', createdAt: 1, updatedAt: 1,
        segments: [block('keep', 'transcript', 'keep this conversation', 1)],
        questions: [], preparedQuestions: [],
        people: [{ id: 'person', name: 'Researcher', createdAt: 2 }],
      }],
    })
    expect(parsed?.contexts[0].segments[0].english).toBe('keep this conversation')
    expect(parsed?.contexts[0].people[0]).toMatchObject({
      name: 'Researcher', details: '', email: '', notes: '',
    })
  })

  it('merges interpreter data into only its owning context and avoids no-op copies', () => {
    const first: ConversationContext = {
      id: 'first', title: 'First', createdAt: 1, updatedAt: 1,
      segments: [], questions: [], preparedQuestions: [], people: [],
    }
    const second: ConversationContext = {
      id: 'second', title: 'Second', createdAt: 2, updatedAt: 2,
      segments: [], questions: [], preparedQuestions: [], people: [],
    }
    const workspace: WorkspaceState = {
      schemaVersion: 2, activeContextId: first.id, contexts: [first, second],
    }
    const nextSegments = [block('new', 'transcript', 'new speech', 3)]
    const nextQuestions: FollowupQuestion[] = []
    const merged = mergeInterpreterSnapshot(
      workspace,
      first.id,
      { segments: nextSegments, questions: nextQuestions, lastQuestionGeneratedAt: 4 },
      5,
    )

    expect(merged.contexts[0]).toMatchObject({
      segments: nextSegments,
      questions: nextQuestions,
      lastQuestionGeneratedAt: 4,
      updatedAt: 5,
    })
    expect(merged.contexts[1]).toBe(second)
    expect(mergeInterpreterSnapshot(
      merged,
      first.id,
      {
        segments: merged.contexts[0].segments,
        questions: merged.contexts[0].questions,
        lastQuestionGeneratedAt: 4,
      },
      6,
    )).toBe(merged)
  })

  it('deletes a context safely, chooses a new active context, and protects the last one', () => {
    const first: ConversationContext = {
      id: 'first', title: 'First', createdAt: 1, updatedAt: 1,
      segments: [], questions: [], preparedQuestions: [], people: [],
    }
    const second: ConversationContext = {
      id: 'second', title: 'Second', createdAt: 2, updatedAt: 2,
      segments: [], questions: [], preparedQuestions: [], people: [],
    }
    const workspace: WorkspaceState = {
      schemaVersion: 2, activeContextId: first.id, contexts: [first, second],
    }

    const removed = removeConversationContext(workspace, first.id)
    expect(removed?.contexts.map((context) => context.id)).toEqual([second.id])
    expect(removed?.activeContextId).toBe(second.id)
    expect(removeConversationContext(removed!, second.id)).toBeNull()
    expect(removeConversationContext(workspace, 'missing')).toBeNull()
  })

  it('rejects invalid persisted workspace data', () => {
    expect(parseWorkspace({ schemaVersion: 999, contexts: [] })).toBeNull()
  })

  it('splits long English into presentation-sized phrases', () => {
    const parts = splitEnglishForPresentation(
      'Would you explain the first point, and then compare it with the second alternative because the distinction matters?',
    )
    expect(parts.length).toBeGreaterThan(1)
  })
})
