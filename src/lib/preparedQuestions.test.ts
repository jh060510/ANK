import { describe, expect, it } from 'vitest'

import type { PreparedQuestion } from '../types'
import {
  arrangePreparedQuestionSlots,
  clearPreparedQuestionSlot,
  DEFAULT_PREPARED_QUESTION_SLOT_COUNT,
  resolvePreparedSlotCount,
  summarizePreparedQuestion,
  upsertPreparedQuestionSlot,
} from './preparedQuestions'

function question(id: string, slot?: number): PreparedQuestion {
  return { id, slot, ko: `질문 ${id}`, en: `Question ${id}`, createdAt: 1 }
}

describe('prepared question slots', () => {
  it('resolves a configurable slot count while preserving occupied slots', () => {
    expect(resolvePreparedSlotCount([], undefined)).toBe(DEFAULT_PREPARED_QUESTION_SLOT_COUNT)
    expect(resolvePreparedSlotCount([], 4)).toBe(4)
    expect(resolvePreparedSlotCount([], 99)).toBe(20)
    expect(resolvePreparedSlotCount([
      { id: 'twenty', slot: 20, ko: '질문', en: 'Question', createdAt: 1 },
    ], 2)).toBe(20)
  })
  it('places legacy questions without slot metadata in order', () => {
    const slots = arrangePreparedQuestionSlots([question('a'), question('b')])
    expect(slots[0].question?.id).toBe('a')
    expect(slots[1].question?.id).toBe('b')
    expect(slots[2].question).toBeNull()
  })

  it('updates the selected slot without shifting other slots', () => {
    const updated = upsertPreparedQuestionSlot(
      [question('a', 1), question('g', 7)],
      7,
      question('replacement'),
    )
    const slots = arrangePreparedQuestionSlots(updated)
    expect(slots[0].question?.id).toBe('a')
    expect(slots[6].question?.id).toBe('replacement')
  })

  it('clears one slot while preserving later slot numbers', () => {
    const cleared = clearPreparedQuestionSlot([question('a', 1), question('g', 7)], 1)
    const slots = arrangePreparedQuestionSlots(cleared)
    expect(slots[0].question).toBeNull()
    expect(slots[6].question?.id).toBe('g')
  })

  it('produces a compact Korean-first summary', () => {
    expect(summarizePreparedQuestion(question('a'))).toBe('질문 a')
    expect(summarizePreparedQuestion(null)).toBe('비어 있음')
  })

  it('caps legacy overflow while editing the twenty visible slots', () => {
    const legacy = Array.from({ length: 22 }, (_, index) => question(String(index + 1)))
    const updated = upsertPreparedQuestionSlot(legacy, 2, question('replacement'))
    const cleared = clearPreparedQuestionSlot(updated, 1)

    expect(updated).toHaveLength(20)
    expect(updated.map((item) => item.id)).not.toContain('21')
    expect(updated.map((item) => item.id)).not.toContain('22')
    expect(cleared).toHaveLength(19)
  })

})
