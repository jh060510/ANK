import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from '../types'
import { applyRefinedGroups, selectRefinementCandidates } from './contextRefinement'

function block(id: string, createdAt: number, state: TranscriptItem['translationState'] = 'ready'): TranscriptItem {
  return { id, kind: 'transcript', english: id, korean: `${id}-ko`, createdAt, translationState: state }
}

describe('safe context refinement', () => {
  it('selects only a settled contiguous transcript window before the cutoff', () => {
    const source = [block('a', 1), block('b', 2), block('pending', 3, 'pending'), block('tail', 4)]
    expect(selectRefinementCandidates(source, 10).map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('merges the captured prefix while preserving speech appended during the request', () => {
    const source = [
      { ...block('a', 1), speaker: 'Speaker 1' },
      { ...block('b', 2), speaker: 'Speaker 1' },
    ]
    const tail = block('new-tail', 3)
    const result = applyRefinedGroups([...source, tail], source, [{
      sourceIds: ['a', 'b'], speaker: 'Speaker 1', english: 'a b', korean: 'a b-ko',
    }])
    expect(result.applied).toBe(true)
    expect(result.segments.map((item) => item.id)).toEqual(['a', 'new-tail'])
    expect(result.segments[0]).toMatchObject({
      english: 'a b',
      speaker: 'Speaker 1',
      sourceIds: ['a', 'b'],
      rawEnglish: 'a\nb',
    })
    expect(result.segments[0].refinedAt).toEqual(expect.any(Number))
  })

  it('rejects a stale response after a source block changes', () => {
    const source = [block('a', 1), block('b', 2)]
    const changed = [{ ...source[0], korean: 'late translation' }, source[1]]
    const result = applyRefinedGroups(changed, source, [{
      sourceIds: ['a', 'b'], speaker: 'Speaker 1', english: 'a b', korean: '번역',
    }])
    expect(result.applied).toBe(false)
    expect(result.segments).toBe(changed)
  })

  it('skips an already refined prefix and selects only newly settled speech', () => {
    const refined = { ...block('old', 1), refinedAt: 100 }
    const fresh = block('fresh', 2)
    expect(selectRefinementCandidates([refined, fresh], 10).map((item) => item.id))
      .toEqual(['fresh'])
  })

  it('reselects a refined block only when its translation needs recovery', () => {
    const failed = { ...block('failed', 1, 'error'), refinedAt: 100, korean: '' }
    expect(selectRefinementCandidates([failed], 10).map((item) => item.id))
      .toEqual(['failed'])
  })

  it('preserves original source provenance across another recovery refinement', () => {
    const previouslyRefined: TranscriptItem = {
      ...block('a', 1, 'error'),
      korean: '',
      sourceIds: ['a', 'b'],
      rawEnglish: 'raw a\nraw b',
      rawKorean: '원문 a\n원문 b',
      refinedAt: 100,
    }
    const result = applyRefinedGroups([previouslyRefined], [previouslyRefined], [{
      sourceIds: ['a'], speaker: 'Speaker 1', english: 'recovered', korean: '복구됨',
    }])
    expect(result.segments[0]).toMatchObject({
      sourceIds: ['a', 'b'],
      rawEnglish: 'raw a\nraw b',
      rawKorean: '원문 a\n원문 b',
    })
  })

  it('does not persist the API-only Speaker placeholder as diarization evidence', () => {
    const unknown = block('unknown', 1)
    const result = applyRefinedGroups([unknown], [unknown], [{
      sourceIds: ['unknown'],
      speaker: 'Speaker',
      english: 'Unknown speaker.',
      korean: '화자 정보가 없습니다.',
    }])

    expect(result.applied).toBe(true)
    expect(result.segments[0].speaker).toBeUndefined()
  })

  it('removes a legacy Speaker placeholder during recovery refinement', () => {
    const legacy = { ...block('legacy', 1, 'error'), speaker: 'Speaker', korean: '' }
    const result = applyRefinedGroups([legacy], [legacy], [{
      sourceIds: ['legacy'],
      speaker: 'Speaker',
      english: 'Recovered text.',
      korean: '복구된 내용입니다.',
    }])

    expect(result.applied).toBe(true)
    expect(result.segments[0].speaker).toBeUndefined()
  })
})
