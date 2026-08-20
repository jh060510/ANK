import { describe, expect, it } from 'vitest'

import {
  combineBilingualExportParts,
  exportBatches,
  EXPORT_PAYLOAD_LIMIT_BYTES,
  rawChatText,
  utf8Bytes,
} from './chatTextExport'
import type { ConversationContext, TranscriptItem } from '../types'

function transcript(overrides: Partial<TranscriptItem> = {}): TranscriptItem {
  return {
    id: 'transcript-1',
    kind: 'transcript',
    english: 'The model is efficient.',
    korean: '이 모델은 효율적입니다.',
    translationState: 'ready',
    createdAt: 1,
    ...overrides,
  }
}

function context(segments: TranscriptItem[]): ConversationContext {
  return {
    id: 'context-1',
    title: 'Interview',
    createdAt: 1,
    updatedAt: 1,
    segments,
    questions: [],
    preparedQuestions: [],
    people: [],
  }
}

describe('Chat Text export', () => {
  it('keeps only English and Korean transcript text in the raw fallback', () => {
    expect(rawChatText(context([
      transcript({ speaker: 'Speaker 1' }),
      transcript({
        id: 'question-1',
        kind: 'question',
        english: 'Should this be exported?',
        korean: '이 질문을 내보내야 하나요?',
      }),
    ]))).toBe([
      'English',
      '[Speaker 1]',
      'The model is efficient.',
      '한국어',
      '[화자 1]',
      '이 모델은 효율적입니다.',
    ].join('\n\n'))
  })

  it('combines multiple API batches into one English section and one Korean section', () => {
    expect(combineBilingualExportParts([
      'English\n\nFirst.\n\n한국어\n\n첫 번째.',
      'English\n\nSecond.\n\n한국어\n\n두 번째.',
    ])).toBe('English\n\nFirst.\n\nSecond.\n\n한국어\n\n첫 번째.\n\n두 번째.')
  })

  it('excludes question blocks while retaining speaker metadata for internal refinement', () => {
    const batches = exportBatches([
      transcript({ speaker: 'Speaker 2' }),
      transcript({ id: 'question-1', kind: 'question' }),
    ])
    expect(batches).toEqual([[
      {
        id: 'transcript-1',
        english: 'The model is efficient.',
        korean: '이 모델은 효율적입니다.',
        speaker: 'Speaker 2',
      },
    ]])
  })

  it('keeps every UTF-8 request batch within the server safety budget', () => {
    const segments = Array.from({ length: 90 }, (_, index) => transcript({
      id: `segment-${index}`,
      english: `English sentence ${index}.`,
      korean: `한국어 문장 ${index}. `.repeat(120),
    }))
    const batches = exportBatches(segments)

    expect(batches.length).toBeGreaterThan(1)
    for (const blocks of batches) {
      expect(utf8Bytes({ blocks })).toBeLessThanOrEqual(EXPORT_PAYLOAD_LIMIT_BYTES)
    }
    expect(batches.flat()).toHaveLength(segments.length)
  })

  it('splits a legacy oversized block without exceeding field or payload limits', () => {
    const batches = exportBatches([
      transcript({
        id: 'legacy-large',
        english: 'a'.repeat(13_000),
        korean: '한'.repeat(13_000),
      }),
    ])
    const blocks = batches.flat()

    expect(blocks.length).toBeGreaterThan(1)
    expect(blocks.every((block) => block.english.length <= 5_800)).toBe(true)
    expect(blocks.every((block) => block.korean.length <= 5_800)).toBe(true)
    expect(batches.every((batch) => utf8Bytes({ blocks: batch }) <= EXPORT_PAYLOAD_LIMIT_BYTES)).toBe(true)
  })
})
